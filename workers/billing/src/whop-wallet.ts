/**
 * Whop sub-merchant wallet — the business-bank-account rail. Replaces the removed Stripe/LS
 * Wallet Connect subsystem entirely (see git history: wallet-connections.ts/wallet-checkout.ts/
 * wallet-webhooks.ts, migration 0063 payment_connections). This is DEFAULT and AUTONOMOUS, not
 * opt-in: every business gets an isolated Whop sub-merchant company the moment it's created,
 * with zero builder action and zero user money required to start.
 *
 * Provisioning is fire-and-forget (`provisionSubMerchant`, called from
 * `workers/spaces/src/create-space.ts`/`business-create.ts` right after the space row exists) —
 * a failure here never blocks business creation; the wallet just stays absent until a retry
 * (surfaced honestly to the assistant via `wallet.balance`'s `status` field, never silently
 * hidden).
 *
 * Money flows (see plan appendix for the full model):
 *   revenue in    → Whop's own storefront/checkout + connected 3rd-party platforms settle
 *                   directly into the sub-merchant's Whop balance; webhook records a
 *                   wallet_transactions row and fires @naelao/events wallet.revenue_received.
 *   platform fee  → transferPlatformFee (payment-splits transfer) runs on the billing cron, not
 *                   per-transaction, sweeping Naelao's own cut into the platform's Whop wallet.
 *   revenue out   → payout_requests: an assistant or owner requests a payout; the FIRST payout
 *                   to a destination requires an emailed one-time approval link (safety
 *                   invariant #5); once a destination is verified, subsequent payouts execute
 *                   directly (still logged, still auditable, never silent).
 *
 * Naelao's ONE Whop master API key (`WHOP_PLATFORM_API_KEY`) is the only credential involved —
 * universal-tools doctrine, exactly like COMPOSIO_API_KEY/TOGETHER_API_KEY: it never reaches an
 * agent isolate, only these HMAC-gated internal routes and the prebuilt scripts that call them.
 */

import { Hono } from "hono";
import { requireInternalHmac, mintInternalToken } from "@naelao/http";
import {
  createSubMerchant,
  getCompanyStatus,
  createSubMerchantCheckout,
  createWithdrawal,
  verifyWhopWebhook,
  parseWhopWalletEvent,
} from "@naelao/billing-core";
import type { BillingEnv } from "./index.js";

const PRIVILEGED_ROLES = new Set(["owner", "admin"]);

export interface WhopSubMerchantRow {
  id: string;
  tenant_id: string;
  space_id: string;
  company_id: string;
  owner_email: string;
  status: "pending" | "active" | "error";
  balance_cents: number;
  currency: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function getSubMerchant(db: D1Database, spaceId: string): Promise<WhopSubMerchantRow | null> {
  return db.prepare("SELECT * FROM whop_sub_merchants WHERE space_id = ?").bind(spaceId).first<WhopSubMerchantRow>();
}

/**
 * Auto-provision a business's Whop sub-merchant wallet. Idempotent: a space already provisioned
 * (any status) is left untouched — this is called once, fire-and-forget, right after the space
 * row is created. Never throws to the caller (business creation must never fail over this);
 * errors are recorded as a `status='error'` row so the assistant can see and retry.
 */
export async function provisionSubMerchant(
  env: BillingEnv,
  params: { tenantId: string; spaceId: string; ownerEmail: string; businessName: string }
): Promise<void> {
  const existing = await getSubMerchant(env.PLATFORM_DB, params.spaceId);
  if (existing) return;

  if (!env.WHOP_PLATFORM_API_KEY) {
    await env.PLATFORM_DB.prepare(
      `INSERT INTO whop_sub_merchants (id, tenant_id, space_id, company_id, owner_email, status)
       VALUES (?, ?, ?, '', ?, 'error')`
    ).bind(crypto.randomUUID(), params.tenantId, params.spaceId, params.ownerEmail).run();
    return;
  }

  try {
    const sub = await createSubMerchant(env.WHOP_PLATFORM_API_KEY, {
      tenantId: params.tenantId,
      businessId: params.spaceId,
      ownerEmail: params.ownerEmail,
      businessName: params.businessName,
    });
    await env.PLATFORM_DB.prepare(
      `INSERT INTO whop_sub_merchants (id, tenant_id, space_id, company_id, owner_email, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), params.tenantId, params.spaceId, sub.company_id, params.ownerEmail, sub.status).run();
  } catch (err) {
    console.error(`[billing/whop-wallet] sub-merchant provisioning failed for space ${params.spaceId}:`, (err as Error).message);
    await env.PLATFORM_DB.prepare(
      `INSERT INTO whop_sub_merchants (id, tenant_id, space_id, company_id, owner_email, status)
       VALUES (?, ?, ?, '', ?, 'error')`
    ).bind(crypto.randomUUID(), params.tenantId, params.spaceId, params.ownerEmail).run();
  }
}

/** Sync the cached balance against Whop's live status. Best-effort — a transient Whop error
 *  returns the last-synced cache rather than failing the read. */
async function syncBalance(env: BillingEnv, row: WhopSubMerchantRow): Promise<WhopSubMerchantRow> {
  if (!env.WHOP_PLATFORM_API_KEY || !row.company_id || row.status === "error") return row;
  try {
    const status = await getCompanyStatus(env.WHOP_PLATFORM_API_KEY, row.company_id);
    await env.PLATFORM_DB.prepare(
      `UPDATE whop_sub_merchants SET balance_cents = ?, currency = ?, status = ?, last_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).bind(status.balance_cents, status.currency, status.status, row.id).run();
    return { ...row, balance_cents: status.balance_cents, currency: status.currency, status: status.status };
  } catch {
    return row;
  }
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function storeVaultCredential(
  env: BillingEnv,
  params: { tenantId: string; spaceId: string; userId: string; name: string; value: string }
): Promise<void> {
  if (!env.CREDENTIALS_WORKER) throw new Error("credentials_unavailable");
  const resp = await env.CREDENTIALS_WORKER.fetch(
    new Request(`http://credentials/spaces/${encodeURIComponent(params.spaceId)}/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": params.tenantId,
        "x-naelao-user-id": params.userId || "whop-wallet",
        "x-naelao-role": "admin",
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, params.tenantId),
      },
      body: JSON.stringify({
        name: params.name,
        value: params.value,
        scope: "space",
        description: "Whop wallet payout destination (managed — do not edit)",
      }),
    })
  );
  if (!resp.ok) throw new Error(`credential store failed (${resp.status})`);
}

/** Fire a business_wallet.* lifecycle event through SpaceDO's existing generic external-event
 *  ingress (POST /internal/spaces/:spaceId/events/fire) so a builder/assistant can wire no-code
 *  triggers to it — best-effort, never blocks the money-side effect that produced it. */
async function fireWalletEvent(
  env: BillingEnv,
  params: { tenantId: string; spaceId: string; type: string; payload?: Record<string, unknown> }
): Promise<void> {
  if (!env.SPACES_WORKER) return;
  try {
    await env.SPACES_WORKER.fetch(
      new Request(`http://spaces-worker/internal/spaces/${encodeURIComponent(params.spaceId)}/events/fire`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": params.tenantId,
          "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, params.tenantId),
        },
        body: JSON.stringify({ type: params.type, space_id: params.spaceId, ...(params.payload ? { payload: params.payload } : {}) }),
      })
    );
  } catch {
    // Best-effort — the wallet_transactions/payout_requests row already recorded the truth.
  }
}

async function sendApprovalEmail(env: BillingEnv, params: { tenantId: string; spaceId: string; ownerEmail: string; approveUrl: string; amountCents: number; currency: string }): Promise<void> {
  if (!env.NOTIFICATIONS_WORKER) return;
  try {
    await env.NOTIFICATIONS_WORKER.fetch(
      new Request("http://notifications-worker/internal/notify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": params.tenantId },
        body: JSON.stringify({
          channel: "email",
          space_id: params.spaceId,
          to: params.ownerEmail,
          subject: "Approve your business wallet payout",
          body: `Your business's assistant requested a payout of ${(params.amountCents / 100).toFixed(2)} ${params.currency}. Approve it here: ${params.approveUrl}\n\nThis link works once. Future payouts to this same destination will not need approval again.`,
        }),
      })
    );
  } catch {
    // Best-effort — the payout request row still exists and is visible in the dashboard/shell.
  }
}

export function registerWhopWalletRoutes(app: Hono<{ Bindings: BillingEnv }>): void {
  app.use("/billing/whop-wallet/*", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));

  async function guard(
    c: { env: BillingEnv; req: { header: (n: string) => string | undefined } },
    spaceId: string,
    opts: { requirePrivileged?: boolean } = {}
  ): Promise<
    | { ok: true; tenantId: string; userId: string }
    | { ok: false; status: 400 | 401 | 403 | 404; error: { error_code: string; message: string } }
  > {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const userId = c.req.header("x-naelao-user-id") ?? "";
    const role = c.req.header("x-naelao-role") ?? "";
    if (!tenantId) return { ok: false, status: 401, error: { error_code: "unauthorized", message: "Missing tenant" } };
    if (!spaceId) return { ok: false, status: 400, error: { error_code: "bad_request", message: "space_id is required" } };
    if (opts.requirePrivileged && !PRIVILEGED_ROLES.has(role)) {
      return { ok: false, status: 403, error: { error_code: "forbidden", message: "Requires owner or admin" } };
    }
    const space = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?").bind(spaceId).first<{ tenant_id: string }>();
    if (!space || space.tenant_id !== tenantId) {
      return { ok: false, status: 404, error: { error_code: "not_found", message: "Space not found" } };
    }
    return { ok: true, tenantId, userId };
  }

  // ── POST /billing/whop-wallet/provision ───────────────────────────────────────────────────────
  // Called fire-and-forget right after a business (space) is created. Idempotent (provisionSubMerchant
  // is a no-op on a space that already has a row) — safe to call more than once.
  app.post("/billing/whop-wallet/provision", async (c) => {
    const body = await c.req.json<{ space_id?: string; owner_email?: string; business_name?: string }>().catch(() => ({}) as Record<string, never>);
    const g = await guard(c, body.space_id ?? "");
    if (!g.ok) return c.json(g.error, g.status);
    if (!body.owner_email || !body.business_name) {
      return c.json({ error_code: "bad_request", message: "owner_email and business_name are required" }, 400);
    }
    await provisionSubMerchant(c.env, {
      tenantId: g.tenantId,
      spaceId: body.space_id!,
      ownerEmail: body.owner_email,
      businessName: body.business_name,
    });
    return c.json({ ok: true });
  });

  // ── GET /billing/whop-wallet/balance?space_id= ────────────────────────────────────────────────
  app.get("/billing/whop-wallet/balance", async (c) => {
    const spaceId = c.req.query("space_id") ?? "";
    const g = await guard(c, spaceId);
    if (!g.ok) return c.json(g.error, g.status);

    let row = await getSubMerchant(c.env.PLATFORM_DB, spaceId);
    if (!row) return c.json({ wallet: null, status: "not_provisioned" });
    row = await syncBalance(c.env, row);
    return c.json({
      wallet: {
        status: row.status,
        balance_cents: row.balance_cents,
        currency: row.currency,
        last_synced_at: row.last_synced_at,
      },
    });
  });

  // ── GET /billing/whop-wallet/transactions?space_id=&limit= ────────────────────────────────────
  app.get("/billing/whop-wallet/transactions", async (c) => {
    const spaceId = c.req.query("space_id") ?? "";
    const g = await guard(c, spaceId);
    if (!g.ok) return c.json(g.error, g.status);
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);

    const { results } = await c.env.PLATFORM_DB.prepare(
      "SELECT type, amount_cents, currency, description, external_ref, created_at FROM wallet_transactions WHERE space_id = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(spaceId, limit).all();
    return c.json({ transactions: results ?? [] });
  });

  // ── GET /billing/whop-wallet/destinations?space_id= ───────────────────────────────────────────
  app.get("/billing/whop-wallet/destinations", async (c) => {
    const spaceId = c.req.query("space_id") ?? "";
    const g = await guard(c, spaceId, { requirePrivileged: true });
    if (!g.ok) return c.json(g.error, g.status);
    const { results } = await c.env.PLATFORM_DB.prepare(
      "SELECT id, type, label, status, is_default, created_at FROM payout_destinations WHERE space_id = ? ORDER BY created_at DESC"
    ).bind(spaceId).all();
    return c.json({ destinations: results ?? [] });
  });

  // ── POST /billing/whop-wallet/destinations ─────────────────────────────────────────────────────
  // Body: { space_id, type, label, details } — details is vaulted, never returned or logged.
  app.post("/billing/whop-wallet/destinations", async (c) => {
    const body = await c.req.json<{ space_id?: string; type?: string; label?: string; details?: Record<string, unknown> }>().catch(() => ({}) as Record<string, never>);
    const g = await guard(c, body.space_id ?? "", { requirePrivileged: true });
    if (!g.ok) return c.json(g.error, g.status);
    if (!body.type || !["bank", "crypto", "venmo", "cashapp"].includes(body.type)) {
      return c.json({ error_code: "bad_request", message: "type must be one of bank, crypto, venmo, cashapp" }, 400);
    }
    if (!body.label || !body.details) {
      return c.json({ error_code: "bad_request", message: "label and details are required" }, 400);
    }
    if (!c.env.CREDENTIALS_WORKER) {
      return c.json({ error_code: "credentials_unavailable", message: "Credential vault is not configured on this platform" }, 503);
    }

    const destinationId = crypto.randomUUID();
    const credentialName = `whop_payout_dest_${destinationId.replace(/-/g, "").slice(0, 16)}`;
    await storeVaultCredential(c.env, {
      tenantId: g.tenantId,
      spaceId: body.space_id!,
      userId: g.userId,
      name: credentialName,
      value: JSON.stringify(body.details),
    });
    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO payout_destinations (id, space_id, type, label, credential_name, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).bind(destinationId, body.space_id!, body.type, body.label, credentialName, g.userId || null).run();

    return c.json({ destination: { id: destinationId, type: body.type, label: body.label, status: "pending" } }, 201);
  });

  // ── POST /billing/whop-wallet/payouts ─────────────────────────────────────────────────────────
  // Body: { space_id, destination_id, amount_cents, note?, requested_by? }. A destination's FIRST
  // payout requires an emailed one-time approval; a previously-EXECUTED destination skips
  // straight to execution (safety invariant #5 — approved once per destination, not once ever).
  app.post("/billing/whop-wallet/payouts", async (c) => {
    const body = await c.req
      .json<{ space_id?: string; destination_id?: string; amount_cents?: number; note?: string; requested_by?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const g = await guard(c, body.space_id ?? "");
    if (!g.ok) return c.json(g.error, g.status);
    if (!body.destination_id || !body.amount_cents || body.amount_cents <= 0) {
      return c.json({ error_code: "bad_request", message: "destination_id and a positive amount_cents are required" }, 400);
    }
    const spaceId = body.space_id!;

    const destination = await c.env.PLATFORM_DB.prepare(
      "SELECT id, status, label FROM payout_destinations WHERE id = ? AND space_id = ?"
    ).bind(body.destination_id, spaceId).first<{ id: string; status: string; label: string }>();
    if (!destination) return c.json({ error_code: "not_found", message: "Payout destination not found" }, 404);

    const wallet = await getSubMerchant(c.env.PLATFORM_DB, spaceId);
    if (!wallet || wallet.status !== "active") {
      return c.json({ error_code: "wallet_not_active", message: "This business's Whop wallet is not yet active" }, 409);
    }
    const synced = await syncBalance(c.env, wallet);
    if (synced.balance_cents < body.amount_cents) {
      return c.json({ error_code: "insufficient_balance", message: "Payout amount exceeds the current wallet balance" }, 409);
    }

    const requestId = crypto.randomUUID();
    // A destination already used for a completed payout is "verified" — subsequent payouts to it
    // execute immediately (still logged). A never-used destination needs the one-time email.
    const previouslyVerified = destination.status === "verified";

    if (previouslyVerified) {
      try {
        const withdrawal = await createWithdrawal(c.env.WHOP_PLATFORM_API_KEY ?? "", wallet.company_id, {
          destinationId: destination.id,
          amountCents: body.amount_cents,
        });
        await c.env.PLATFORM_DB.prepare(
          `INSERT INTO payout_requests (id, space_id, destination_id, amount_cents, note, status, requested_by, whop_withdrawal_id, updated_at)
           VALUES (?, ?, ?, ?, ?, 'executed', ?, ?, datetime('now'))`
        ).bind(requestId, spaceId, destination.id, body.amount_cents, body.note ?? null, body.requested_by ?? null, withdrawal.withdrawal_id).run();
        await c.env.PLATFORM_DB.prepare(
          `INSERT INTO wallet_transactions (id, space_id, type, amount_cents, currency, description, external_ref)
           VALUES (?, ?, 'payout', ?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), spaceId, -body.amount_cents, synced.currency, `Payout to ${destination.label}`, withdrawal.withdrawal_id).run();
        await fireWalletEvent(c.env, {
          tenantId: g.tenantId, spaceId, type: "business_wallet.payout_completed",
          payload: { amount_cents: body.amount_cents, withdrawal_id: withdrawal.withdrawal_id },
        });
        return c.json({ payout: { id: requestId, status: "executed", withdrawal_id: withdrawal.withdrawal_id } }, 201);
      } catch (err) {
        await c.env.PLATFORM_DB.prepare(
          `INSERT INTO payout_requests (id, space_id, destination_id, amount_cents, note, status, requested_by)
           VALUES (?, ?, ?, ?, ?, 'failed', ?)`
        ).bind(requestId, spaceId, destination.id, body.amount_cents, body.note ?? null, body.requested_by ?? null).run();
        return c.json({ error_code: "payout_failed", message: (err as Error).message }, 502);
      }
    }

    // First payout to this destination — require owner approval via a single-use emailed link.
    const approvalToken = randomHex(32);
    const approvalTokenHash = await sha256Hex(approvalToken);
    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO payout_requests (id, space_id, destination_id, amount_cents, note, status, approval_token_hash, requested_by)
       VALUES (?, ?, ?, ?, ?, 'pending_approval', ?, ?)`
    ).bind(requestId, spaceId, destination.id, body.amount_cents, body.note ?? null, approvalTokenHash, body.requested_by ?? null).run();

    if (c.env.PUBLIC_WEBHOOK_BASE_URL) {
      const approveUrl = `${c.env.PUBLIC_WEBHOOK_BASE_URL.replace(/\/$/, "")}/v1/webhooks/whop-wallet/payouts/${requestId}/approve?token=${approvalToken}`;
      await sendApprovalEmail(c.env, {
        tenantId: g.tenantId,
        spaceId,
        ownerEmail: wallet.owner_email,
        approveUrl,
        amountCents: body.amount_cents,
        currency: synced.currency,
      });
    }
    await fireWalletEvent(c.env, {
      tenantId: g.tenantId, spaceId, type: "business_wallet.payout_requested",
      payload: { amount_cents: body.amount_cents, destination_id: destination.id },
    });

    return c.json({ payout: { id: requestId, status: "pending_approval" } }, 201);
  });

  // ── GET /billing/whop-wallet/payouts?space_id= ────────────────────────────────────────────────
  app.get("/billing/whop-wallet/payouts", async (c) => {
    const spaceId = c.req.query("space_id") ?? "";
    const g = await guard(c, spaceId, { requirePrivileged: true });
    if (!g.ok) return c.json(g.error, g.status);
    const { results } = await c.env.PLATFORM_DB.prepare(
      "SELECT id, destination_id, amount_cents, note, status, created_at FROM payout_requests WHERE space_id = ? ORDER BY created_at DESC LIMIT 100"
    ).bind(spaceId).all();
    return c.json({ payouts: results ?? [] });
  });
}

/**
 * Public, unauthenticated approval-link handler — GET /v1/webhooks/whop-wallet/payouts/:id/approve.
 * The single-use token IS the auth (mirrors business_invites/password-reset-token precedent).
 * On approval: marks the destination 'verified' (so FUTURE payouts skip this step) and executes
 * the withdrawal immediately.
 */
export async function handlePayoutApproval(env: BillingEnv, requestId: string, token: string): Promise<Response> {
  if (!token) return new Response("Missing approval token", { status: 400 });
  const tokenHash = await sha256Hex(token);

  const request = await env.PLATFORM_DB.prepare(
    "SELECT id, space_id, destination_id, amount_cents, status, approval_token_hash FROM payout_requests WHERE id = ?"
  ).bind(requestId).first<{ id: string; space_id: string; destination_id: string; amount_cents: number; status: string; approval_token_hash: string | null }>();
  if (!request || request.status !== "pending_approval" || !request.approval_token_hash) {
    return new Response("This payout request is no longer pending approval.", { status: 410 });
  }
  if (request.approval_token_hash !== tokenHash) {
    return new Response("Invalid approval token.", { status: 401 });
  }

  const wallet = await getSubMerchant(env.PLATFORM_DB, request.space_id);
  if (!wallet || !wallet.company_id) {
    return new Response("Wallet unavailable.", { status: 503 });
  }

  try {
    const withdrawal = await createWithdrawal(env.WHOP_PLATFORM_API_KEY ?? "", wallet.company_id, {
      destinationId: request.destination_id,
      amountCents: request.amount_cents,
    });
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare("UPDATE payout_requests SET status = 'executed', whop_withdrawal_id = ?, updated_at = datetime('now') WHERE id = ?").bind(withdrawal.withdrawal_id, request.id),
      env.PLATFORM_DB.prepare("UPDATE payout_destinations SET status = 'verified' WHERE id = ?").bind(request.destination_id),
      env.PLATFORM_DB.prepare(
        `INSERT INTO wallet_transactions (id, space_id, type, amount_cents, currency, description, external_ref)
         VALUES (?, ?, 'payout', ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), request.space_id, -request.amount_cents, wallet.currency, "Approved payout", withdrawal.withdrawal_id),
    ]);
    await fireWalletEvent(env, {
      tenantId: wallet.tenant_id, spaceId: request.space_id, type: "business_wallet.payout_completed",
      payload: { amount_cents: request.amount_cents, withdrawal_id: withdrawal.withdrawal_id },
    });
    return new Response("Payout approved and sent. You can close this page.", { status: 200 });
  } catch (err) {
    await env.PLATFORM_DB.prepare("UPDATE payout_requests SET status = 'failed', updated_at = datetime('now') WHERE id = ?").bind(request.id).run();
    return new Response(`Payout failed: ${(err as Error).message}`, { status: 502 });
  }
}

/**
 * Sub-merchant checkout routing for Naelao-store product sales — when a business's Whop wallet
 * is active, a product checkout settles directly into it (with Naelao's platform fee auto-split)
 * instead of Naelao's own Lemon Squeezy store. Returns null when the wallet isn't active yet
 * (provisioning still in flight) so the caller falls through to the existing Naelao-store path
 * byte-identically — provisioning lag must never block a sale.
 */
export async function routeWhopWalletCheckout(
  env: BillingEnv,
  args: { spaceId: string; productName: string; amountCents: number; currency: string; customerEmail?: string; feeBps: number; metadata?: Record<string, string> }
): Promise<{ checkout_url: string } | null> {
  const wallet = await getSubMerchant(env.PLATFORM_DB, args.spaceId);
  if (!wallet || wallet.status !== "active" || !env.WHOP_PLATFORM_API_KEY) return null;

  const platformFeeCents = Math.round((args.amountCents * args.feeBps) / 10_000);
  return createSubMerchantCheckout(env.WHOP_PLATFORM_API_KEY, {
    companyId: wallet.company_id,
    productName: args.productName,
    amountCents: args.amountCents,
    currency: args.currency,
    ...(args.customerEmail ? { customerEmail: args.customerEmail } : {}),
    platformFeeCents,
    metadata: { space_id: args.spaceId, ...(args.metadata ?? {}) },
  });
}

/** POST /webhooks/whop — revenue-in events from a business's own Whop sub-merchant company. */
export async function handleWhopWebhook(request: Request, env: BillingEnv): Promise<Response> {
  if (!env.WHOP_WEBHOOK_SECRET) {
    return Response.json({ error: "whop_not_configured" }, { status: 503 });
  }
  const rawBody = await request.text();
  const valid = await verifyWhopWebhook(rawBody, request.headers, env.WHOP_WEBHOOK_SECRET);
  if (!valid) {
    console.warn("[billing/whop-wallet] webhook signature verification failed");
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  let event;
  try {
    event = parseWhopWalletEvent(rawBody);
  } catch (err) {
    console.log("[billing/whop-wallet] unparseable event:", (err as Error).message);
    return Response.json({ ok: true, skipped: true });
  }
  if (event.type === "unknown" || !event.companyId) {
    return Response.json({ ok: true, skipped: true });
  }

  const wallet = await env.PLATFORM_DB.prepare("SELECT space_id, tenant_id FROM whop_sub_merchants WHERE company_id = ?")
    .bind(event.companyId)
    .first<{ space_id: string; tenant_id: string }>();
  if (!wallet) {
    console.warn(`[billing/whop-wallet] event for unknown company ${event.companyId}`);
    return Response.json({ ok: true, skipped: true });
  }

  const txType = event.type === "revenue_received" ? "revenue" : event.type === "payout_completed" ? "payout" : "expense";
  await env.PLATFORM_DB.prepare(
    `INSERT OR IGNORE INTO wallet_transactions (id, space_id, type, amount_cents, currency, description, external_ref, provider_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(), wallet.space_id, txType,
    event.type === "revenue_received" ? event.amountCents : -event.amountCents,
    event.currency, `Whop ${event.type}`, event.providerEventId, event.providerEventId
  ).run();

  if (event.type === "revenue_received") {
    await fireWalletEvent(env, {
      tenantId: wallet.tenant_id, spaceId: wallet.space_id, type: "business_wallet.revenue_received",
      payload: { amount_cents: event.amountCents, currency: event.currency },
    });
  }

  return Response.json({ ok: true, event_type: event.type, space_id: wallet.space_id });
}
