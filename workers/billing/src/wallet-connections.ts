/**
 * Wallet Connect — a space's OWN payment account (migration 0063 payment_connections).
 *
 * Two rails, one safety model (revenue settles into an account the builder owns; Naelao never
 * holds their funds and can never debit them — the integration surface is checkout creation,
 * account-status reads, and webhook receives only):
 *
 *   stripe        → the "Sign in with Google"-style flow: we create a FRESH Express connected
 *                   account (an isolated business account, never a link to a personal one) with
 *                   Naelao's ONE platform integration key (universal-tools doctrine, like
 *                   COMPOSIO_API_KEY), then redirect the builder to Stripe-HOSTED onboarding for
 *                   consent/KYC/bank details (Naelao never sees any of it). The connection only
 *                   activates when Stripe reports charges_enabled — per Stripe's own docs the
 *                   onboarding return redirect does NOT mean onboarding completed.
 *
 *   lemon_squeezy → guided BYO (LS has NO OAuth and NO create-store API): the builder creates a
 *                   dedicated LS store, pastes an API key; we verify it by listing its stores,
 *                   let them pick one, store the key ENCRYPTED in the credentials vault (never
 *                   D1 plaintext, never an agent isolate), and auto-create a webhook on THEIR
 *                   store with a generated per-connection signing secret.
 *
 * All routes are requireInternalHmac-gated: naelao-router mints the token for proxied builder
 * requests (from verified JWT claims), and the spaces worker mints it for the shell's
 * business-admin wrapper — same posture as every other /internal-grade route in this worker.
 */

import { Hono } from "hono";
import { requireInternalHmac } from "@naelao/http";
import {
  createAccountLink,
  createExpressAccount,
  getAccountStatus,
  lsCreateWebhook,
  lsDeleteWebhook,
  lsListStores,
} from "@naelao/billing-core";
import type { BillingEnv } from "./index.js";

const PRIVILEGED_ROLES = new Set(["owner", "admin"]);

export interface PaymentConnectionRow {
  id: string;
  tenant_id: string;
  space_id: string;
  provider: "stripe" | "lemon_squeezy";
  status: "pending" | "active" | "disabled" | "error";
  provider_account_id: string | null;
  credential_name: string | null;
  webhook_secret_credential: string | null;
  details_json: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** The live (non-disabled) connection for a space, if any. */
export async function getLivePaymentConnection(
  db: D1Database,
  spaceId: string
): Promise<PaymentConnectionRow | null> {
  return db
    .prepare("SELECT * FROM payment_connections WHERE space_id = ? AND status != 'disabled' LIMIT 1")
    .bind(spaceId)
    .first<PaymentConnectionRow>();
}

/** Resolve a connection by which provider account a webhook event happened on. */
export async function getConnectionByProviderAccount(
  db: D1Database,
  provider: "stripe" | "lemon_squeezy",
  providerAccountId: string
): Promise<PaymentConnectionRow | null> {
  return db
    .prepare(
      "SELECT * FROM payment_connections WHERE provider = ? AND provider_account_id = ? AND status != 'disabled' LIMIT 1"
    )
    .bind(provider, providerAccountId)
    .first<PaymentConnectionRow>();
}

export async function getConnectionById(
  db: D1Database,
  connectionId: string
): Promise<PaymentConnectionRow | null> {
  return db
    .prepare("SELECT * FROM payment_connections WHERE id = ? LIMIT 1")
    .bind(connectionId)
    .first<PaymentConnectionRow>();
}

function parseDetails(row: PaymentConnectionRow): Record<string, unknown> {
  try {
    return JSON.parse(row.details_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Public projection — never includes vault credential names or raw provider payloads. */
function sanitizeConnection(row: PaymentConnectionRow): Record<string, unknown> {
  const details = parseDetails(row);
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    provider_account_id: row.provider_account_id,
    details: {
      charges_enabled: details["charges_enabled"] === true,
      payouts_enabled: details["payouts_enabled"] === true,
      details_submitted: details["details_submitted"] === true,
      store_name: typeof details["store_name"] === "string" ? details["store_name"] : null,
      webhook_created: details["webhook_created"] !== false,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Credentials-vault access ────────────────────────────────────────────────────────────────────
// Mirrors workers/mcp-hub's own local generateCredentialToken (the established convention: each
// caller of the plaintext endpoint mints the short-lived token itself).

async function generateCredentialToken(
  platformSecret: string,
  spaceId: string,
  agentId: string
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${spaceId}:${agentId}:${timestamp}`)
  );
  const hexSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},aid=${agentId},v1=${hexSig}`;
}

async function storeVaultCredential(
  env: BillingEnv,
  params: { tenantId: string; spaceId: string; userId: string; name: string; value: string }
): Promise<void> {
  if (!env.CREDENTIALS_WORKER) throw new Error("credentials_unavailable");
  const { mintInternalToken } = await import("@naelao/http");
  const resp = await env.CREDENTIALS_WORKER.fetch(
    new Request(`http://credentials/spaces/${encodeURIComponent(params.spaceId)}/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": params.tenantId,
        "x-naelao-user-id": params.userId || "wallet-connect",
        "x-naelao-role": "admin",
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, params.tenantId),
      },
      body: JSON.stringify({
        name: params.name,
        value: params.value,
        scope: "space",
        description: "Wallet Connect (managed — do not edit)",
      }),
    })
  );
  if (!resp.ok) {
    throw new Error(`credential store failed (${resp.status})`);
  }
}

/** Decrypted vault read for wallet operations (webhook verify, checkout, disconnect cleanup). */
export async function fetchWalletVaultSecret(
  env: BillingEnv,
  tenantId: string,
  spaceId: string,
  name: string
): Promise<string | null> {
  if (!env.CREDENTIALS_WORKER) return null;
  try {
    const token = await generateCredentialToken(env.PLATFORM_SECRET, spaceId, "billing-wallet");
    const resp = await env.CREDENTIALS_WORKER.fetch(
      new Request(
        `http://credentials/v1/internal/spaces/${encodeURIComponent(spaceId)}/credentials/${encodeURIComponent(name)}/plaintext`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-naelao-tenant-id": tenantId,
            "x-naelao-credential-token": token,
          },
          body: "{}",
        }
      )
    );
    if (!resp.ok) return null;
    const json = await resp.json<{ value?: string }>();
    return json.value ?? null;
  } catch {
    return null;
  }
}

// ── Route registration ──────────────────────────────────────────────────────────────────────────

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Vault-safe per-connection credential name (alnum+underscore, unique per connection). */
function connCredName(kind: "key" | "whsec", connectionId: string): string {
  return `wallet_ls_${kind}_${connectionId.replace(/-/g, "").slice(0, 16)}`;
}

export function registerWalletConnectionRoutes(app: Hono<{ Bindings: BillingEnv }>): void {
  app.use("/billing/wallet/*", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));

  /** Shared per-request guard: verified tenant, privileged role, space owned by tenant. */
  async function guard(
    c: { env: BillingEnv; req: { header: (n: string) => string | undefined } },
    spaceId: string
  ): Promise<
    | { ok: true; tenantId: string; userId: string }
    | { ok: false; status: 400 | 401 | 403 | 404; error: { error_code: string; message: string } }
  > {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const userId = c.req.header("x-naelao-user-id") ?? "";
    const role = c.req.header("x-naelao-role") ?? "";
    if (!tenantId) return { ok: false, status: 401, error: { error_code: "unauthorized", message: "Missing tenant" } };
    if (!spaceId) return { ok: false, status: 400, error: { error_code: "bad_request", message: "space_id is required" } };
    // Payment configuration is owner/admin-only on every surface: the dashboard (builder JWT
    // role) and the shell wrapper (spaces worker sets role=admin only after its own
    // requireBusinessMembership admin check). This also keeps role="agent" API keys out —
    // an agent must never be able to connect or disconnect a payment account.
    if (!PRIVILEGED_ROLES.has(role)) {
      return { ok: false, status: 403, error: { error_code: "forbidden", message: "Requires owner or admin" } };
    }
    const space = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
      .bind(spaceId)
      .first<{ tenant_id: string }>();
    if (!space || space.tenant_id !== tenantId) {
      return { ok: false, status: 404, error: { error_code: "not_found", message: "Space not found" } };
    }
    return { ok: true, tenantId, userId };
  }

  // ── GET /billing/wallet/connection?space_id= ──────────────────────────────────────────────────
  app.get("/billing/wallet/connection", async (c) => {
    const g = await guard(c, c.req.query("space_id") ?? "");
    if (!g.ok) return c.json(g.error, g.status);
    const spaceId = c.req.query("space_id") ?? "";

    const row = await getLivePaymentConnection(c.env.PLATFORM_DB, spaceId);
    if (!row) return c.json({ connection: null });

    // Stripe onboarding completes out-of-band and the return redirect proves nothing — live-poll
    // account status while pending and activate on charges_enabled.
    if (row.provider === "stripe" && row.status === "pending" && row.provider_account_id && c.env.STRIPE_PLATFORM_SECRET_KEY) {
      try {
        const status = await getAccountStatus(c.env.STRIPE_PLATFORM_SECRET_KEY, row.provider_account_id);
        const details = { ...parseDetails(row), charges_enabled: status.charges_enabled, payouts_enabled: status.payouts_enabled, details_submitted: status.details_submitted };
        const nextStatus = status.charges_enabled ? "active" : "pending";
        await c.env.PLATFORM_DB.prepare(
          "UPDATE payment_connections SET status = ?, details_json = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(nextStatus, JSON.stringify(details), row.id).run();
        row.status = nextStatus as PaymentConnectionRow["status"];
        row.details_json = JSON.stringify(details);
      } catch {
        // Transient Stripe error must not break the read — return the stored state.
      }
    }
    return c.json({ connection: sanitizeConnection(row) });
  });

  // ── POST /billing/wallet/connect/stripe ───────────────────────────────────────────────────────
  // Body: { space_id, return_url, refresh_url? }. Creates the fresh Express account + hosted
  // onboarding link. Idempotent-ish: an existing PENDING stripe connection gets a fresh link
  // instead of a second account.
  app.post("/billing/wallet/connect/stripe", async (c) => {
    const body = await c.req.json<{ space_id?: string; return_url?: string; refresh_url?: string }>().catch(() => ({}) as Record<string, never>);
    const g = await guard(c, body.space_id ?? "");
    if (!g.ok) return c.json(g.error, g.status);
    if (!body.return_url) return c.json({ error_code: "bad_request", message: "return_url is required" }, 400);
    if (!c.env.STRIPE_PLATFORM_SECRET_KEY) {
      return c.json({ error_code: "stripe_not_configured", message: "Stripe Connect is not configured on this platform" }, 503);
    }
    const spaceId = body.space_id!;

    const existing = await getLivePaymentConnection(c.env.PLATFORM_DB, spaceId);
    if (existing && !(existing.provider === "stripe" && existing.status === "pending")) {
      return c.json({ error_code: "already_connected", message: `A ${existing.provider} payment connection already exists — disconnect it first` }, 409);
    }

    let accountId = existing?.provider_account_id ?? null;
    let connectionId = existing?.id ?? null;
    if (!accountId) {
      // Prefill the onboarding email from the builder's own account, like /billing/checkout does.
      const owner = g.userId
        ? await c.env.PLATFORM_DB.prepare("SELECT email FROM users WHERE id = ? LIMIT 1").bind(g.userId).first<{ email: string }>()
        : null;
      const account = await createExpressAccount(c.env.STRIPE_PLATFORM_SECRET_KEY, {
        tenantId: g.tenantId,
        spaceId,
        ...(owner?.email ? { email: owner.email } : {}),
      });
      accountId = account.id;
      connectionId = crypto.randomUUID();
      await c.env.PLATFORM_DB.prepare(
        `INSERT INTO payment_connections (id, tenant_id, space_id, provider, status, provider_account_id, details_json, created_by)
         VALUES (?, ?, ?, 'stripe', 'pending', ?, '{}', ?)`
      ).bind(connectionId, g.tenantId, spaceId, accountId, g.userId || null).run();
    }

    const link = await createAccountLink(
      c.env.STRIPE_PLATFORM_SECRET_KEY,
      accountId,
      body.refresh_url ?? body.return_url,
      body.return_url
    );
    return c.json({ connection_id: connectionId, provider: "stripe", status: "pending", onboarding_url: link.url });
  });

  // ── POST /billing/wallet/connect/lemon-squeezy ────────────────────────────────────────────────
  // Body: { space_id, api_key, store_id? }. Two-step guided flow:
  //   without store_id → verify the key, return its store list for the picker (NOTHING persisted);
  //   with store_id    → vault the key + a generated webhook signing secret, auto-create the
  //                      webhook on THEIR store, activate the connection.
  app.post("/billing/wallet/connect/lemon-squeezy", async (c) => {
    const body = await c.req
      .json<{ space_id?: string; api_key?: string; store_id?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const g = await guard(c, body.space_id ?? "");
    if (!g.ok) return c.json(g.error, g.status);
    if (!body.api_key) return c.json({ error_code: "bad_request", message: "api_key is required" }, 400);
    const spaceId = body.space_id!;

    let stores;
    try {
      stores = await lsListStores(body.api_key);
    } catch {
      return c.json({ error_code: "invalid_api_key", message: "Lemon Squeezy rejected this API key" }, 400);
    }

    if (!body.store_id) {
      return c.json({ stores, next: "pick a store_id and call again" });
    }

    const store = stores.find((s) => s.id === String(body.store_id));
    if (!store) {
      return c.json({ error_code: "store_not_found", message: "This API key cannot see that store" }, 400);
    }

    const existing = await getLivePaymentConnection(c.env.PLATFORM_DB, spaceId);
    if (existing) {
      return c.json({ error_code: "already_connected", message: `A ${existing.provider} payment connection already exists — disconnect it first` }, 409);
    }
    if (!c.env.CREDENTIALS_WORKER) {
      return c.json({ error_code: "credentials_unavailable", message: "Credential vault is not configured on this platform" }, 503);
    }

    const connectionId = crypto.randomUUID();
    const keyName = connCredName("key", connectionId);
    const secretName = connCredName("whsec", connectionId);
    const webhookSecret = randomHex(32);

    // Vault BEFORE any provider-side mutation: if the vault write fails we've changed nothing.
    await storeVaultCredential(c.env, { tenantId: g.tenantId, spaceId, userId: g.userId, name: keyName, value: body.api_key });
    await storeVaultCredential(c.env, { tenantId: g.tenantId, spaceId, userId: g.userId, name: secretName, value: webhookSecret });

    // Auto-create the webhook on the builder's store. Needs a public base URL for the wallet
    // webhook route — degrades honestly (connection still activates, webhook_created:false is
    // surfaced) when unset, the same optional-config convention as every dev placeholder here.
    const details: Record<string, unknown> = { store_name: store.name };
    if (c.env.PUBLIC_WEBHOOK_BASE_URL) {
      const webhookUrl = `${c.env.PUBLIC_WEBHOOK_BASE_URL.replace(/\/$/, "")}/v1/webhooks/lemon-squeezy/wallet/${connectionId}`;
      try {
        const webhook = await lsCreateWebhook(body.api_key, store.id, webhookUrl, webhookSecret);
        details["ls_webhook_id"] = webhook.id;
        details["webhook_created"] = true;
      } catch {
        details["webhook_created"] = false;
        details["webhook_error"] = "Lemon Squeezy webhook creation failed — orders will not sync until reconnected";
      }
    } else {
      details["webhook_created"] = false;
    }

    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO payment_connections (id, tenant_id, space_id, provider, status, provider_account_id, credential_name, webhook_secret_credential, details_json, created_by)
       VALUES (?, ?, ?, 'lemon_squeezy', 'active', ?, ?, ?, ?, ?)`
    ).bind(connectionId, g.tenantId, spaceId, store.id, keyName, secretName, JSON.stringify(details), g.userId || null).run();

    const row = await getConnectionById(c.env.PLATFORM_DB, connectionId);
    return c.json({ connection: row ? sanitizeConnection(row) : null }, 201);
  });

  // ── DELETE /billing/wallet/connection?space_id= ───────────────────────────────────────────────
  // Marks disabled (audit row kept). Best-effort LS webhook cleanup; the Stripe connected account
  // is the BUILDER's business account and is deliberately never deleted from here — they keep it
  // (and its balance/history) via their own Stripe Express dashboard.
  app.delete("/billing/wallet/connection", async (c) => {
    const spaceId = c.req.query("space_id") ?? "";
    const g = await guard(c, spaceId);
    if (!g.ok) return c.json(g.error, g.status);

    const row = await getLivePaymentConnection(c.env.PLATFORM_DB, spaceId);
    if (!row) return c.json({ error_code: "not_found", message: "No payment connection" }, 404);

    if (row.provider === "lemon_squeezy" && row.credential_name) {
      const details = parseDetails(row);
      const webhookId = typeof details["ls_webhook_id"] === "string" ? details["ls_webhook_id"] : null;
      if (webhookId) {
        const apiKey = await fetchWalletVaultSecret(c.env, g.tenantId, spaceId, row.credential_name);
        if (apiKey) {
          try {
            await lsDeleteWebhook(apiKey, webhookId);
          } catch {
            // Best-effort — never blocks the disconnect.
          }
        }
      }
    }

    await c.env.PLATFORM_DB.prepare(
      "UPDATE payment_connections SET status = 'disabled', updated_at = datetime('now') WHERE id = ?"
    ).bind(row.id).run();
    return c.json({ disconnected: true, provider: row.provider });
  });
}
