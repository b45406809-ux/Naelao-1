import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import billingWorker from "../../workers/billing/src/index.js";
import { handlePayoutApproval, provisionSubMerchant, getSubMerchant } from "../../workers/billing/src/whop-wallet.js";
import type { BillingEnv } from "../../workers/billing/src/index.js";
import { verifyWhopWebhook } from "../../packages/billing-core/src/providers/whop.js";
import { mintInternalToken } from "@naelao/http";

// Whop sub-merchant wallets — the business-bank-account rail (replaces the removed Stripe/LS
// Wallet Connect subsystem). Safety invariants under test:
//   1. Sub-merchant provisioning is idempotent — a space is never re-provisioned.
//   2. Business A cannot read/payout from business B's wallet (tenant isolation).
//   3. A webhook event is recorded exactly once (idempotency) and NEVER trusts the caller's own
//      claimed company_id/space mapping — it resolves from whop_sub_merchants.
//   4. A payout to a NEW destination requires a one-time owner approval before Whop is ever
//      called; a payout to an already-verified destination executes directly.
//   5. Insufficient balance rejects a payout request outright (no partial payout).
//   6. The Whop master API key never appears in any D1 row.

const PLATFORM_SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_SQL = `CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');`;
const MIGRATIONS = [
  SPACES_SQL,
  readFileSync(join(__dirname, "../../infra/migrations/0064_whop_sub_merchants.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0065_whop_kyc_onboarding.sql"), "utf8"),
];

function makeDb() {
  const db = createFakeD1(MIGRATIONS);
  db.db.exec("INSERT INTO spaces (id, tenant_id, status) VALUES ('space-a', 'tenant-a', 'active')");
  db.db.exec("INSERT INTO spaces (id, tenant_id, status) VALUES ('space-b', 'tenant-b', 'active')");
  return db;
}

interface ProviderCall { url: string; method: string; body: string | null }

/** Intercept outbound Whop API calls. */
function mockWhopFetch(routes: Array<{ match: RegExp; method?: string; respond: (call: ProviderCall) => Response }>) {
  const original = globalThis.fetch;
  const calls: ProviderCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const call: ProviderCall = { url: req.url, method: req.method, body: req.body ? await req.clone().text() : (init?.body as string | null) ?? null };
    calls.push(call);
    for (const r of routes) {
      if (r.match.test(req.url) && (!r.method || r.method === req.method)) return r.respond(call);
    }
    return new Response(JSON.stringify({ error: `unmocked: ${req.method} ${req.url}` }), { status: 500 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

let restoreFetch: (() => void) | null = null;
afterEach(() => { restoreFetch?.(); restoreFetch = null; });

async function walletReq(
  path: string,
  opts: { method?: string; body?: unknown; tenantId?: string; role?: string; userId?: string } = {}
): Promise<Request> {
  const tenantId = opts.tenantId ?? "tenant-a";
  return new Request(`https://billing.naelao.com${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": tenantId,
      "x-naelao-user-id": opts.userId ?? "user-1",
      "x-naelao-role": opts.role ?? "owner",
      "x-naelao-internal-token": await mintInternalToken(PLATFORM_SECRET, tenantId),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

function makeEnv(db: ReturnType<typeof makeDb>, overrides: Partial<BillingEnv> = {}): BillingEnv {
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET,
    PLATFORM_DB: db as unknown as D1Database,
    WHOP_PLATFORM_API_KEY: "whop_master_key",
    WHOP_WEBHOOK_SECRET: "whop-webhook-secret",
    QUOTA_CACHE: undefined as never,
    BILLING_EVENTS: undefined as never,
    ...overrides,
  } as BillingEnv;
}

async function whopSign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── 1. WhopProvider webhook signature + event parsing ──────────────────────────────────────────

describe("verifyWhopWebhook", () => {
  it("accepts a correctly-signed body and rejects a tampered one", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "payment.succeeded", data: { company_id: "co_1", final_amount: 1000 } });
    const sig = await whopSign("whsec", body);
    const okHeaders = new Headers({ "whop-signature": sig });
    expect(await verifyWhopWebhook(body, okHeaders, "whsec")).toBe(true);

    const badHeaders = new Headers({ "whop-signature": "deadbeef" });
    expect(await verifyWhopWebhook(body, badHeaders, "whsec")).toBe(false);
    expect(await verifyWhopWebhook(body, okHeaders, "wrong-secret")).toBe(false);
  });
});

// ── 2. Sub-merchant provisioning — idempotent, no double-provision ─────────────────────────────

describe("provisionSubMerchant", () => {
  it("creates exactly one row even when called twice", async () => {
    const db = makeDb();
    restoreFetch = mockWhopFetch([
      { match: /\/v5\/platforms\/sub_merchants$/, method: "POST", respond: () => Response.json({ id: "co_new", status: "active" }) },
    ]).restore;
    const { restore } = mockWhopFetch([
      { match: /\/v5\/platforms\/sub_merchants$/, method: "POST", respond: () => Response.json({ id: "co_new", status: "active" }) },
    ]);
    restoreFetch = restore;

    const env = makeEnv(db);
    await provisionSubMerchant(env, { tenantId: "tenant-a", spaceId: "space-a", ownerEmail: "a@example.com", businessName: "Biz A" });
    await provisionSubMerchant(env, { tenantId: "tenant-a", spaceId: "space-a", ownerEmail: "a@example.com", businessName: "Biz A" });

    const { results } = await db.prepare("SELECT * FROM whop_sub_merchants WHERE space_id = ?").bind("space-a").all();
    expect(results?.length).toBe(1);
  });

  it("records status='error' honestly (never fabricates a company id) when the platform key is unset", async () => {
    const db = makeDb();
    const env = makeEnv(db, { WHOP_PLATFORM_API_KEY: undefined });
    await provisionSubMerchant(env, { tenantId: "tenant-a", spaceId: "space-a", ownerEmail: "a@example.com", businessName: "Biz A" });
    const row = await getSubMerchant(db as unknown as D1Database, "space-a");
    expect(row?.status).toBe("error");
    expect(row?.company_id).toBe("");
  });

  it("records status='awaiting_kyc' + the onboarding link when Whop returns one, and best-effort emails the owner", async () => {
    const db = makeDb();
    const { calls, restore } = mockWhopFetch([
      { match: /\/v5\/platforms\/sub_merchants$/, method: "POST", respond: () => Response.json({ id: "co_new", onboarding_url: "https://whop.com/onboard/abc123" }) },
    ]);
    restoreFetch = restore;
    const notifyCalls: { url: string; body: unknown }[] = [];
    const env = makeEnv(db, {
      NOTIFICATIONS_WORKER: {
        async fetch(reqInput: Request | string, init?: RequestInit) {
          const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
          notifyCalls.push({ url: req.url, body: await req.clone().json() });
          return Response.json({ delivered: true });
        },
      } as unknown as Fetcher,
    });

    await provisionSubMerchant(env, { tenantId: "tenant-a", spaceId: "space-a", ownerEmail: "a@example.com", businessName: "Biz A" });

    const row = await getSubMerchant(db as unknown as D1Database, "space-a");
    expect(row?.status).toBe("awaiting_kyc");
    expect(row?.onboarding_url).toBe("https://whop.com/onboard/abc123");
    expect(calls.some((c) => /\/v5\/platforms\/sub_merchants$/.test(c.url))).toBe(true);
    expect(notifyCalls.length).toBe(1);
    expect((notifyCalls[0]!.body as { to: string }).to).toBe("a@example.com");
    expect(JSON.stringify(notifyCalls[0]!.body)).toContain("abc123");
  });

  it("an owner with an existing Whop account (no onboarding link needed) provisions straight to active", async () => {
    const db = makeDb();
    restoreFetch = mockWhopFetch([
      { match: /\/v5\/platforms\/sub_merchants$/, method: "POST", respond: () => Response.json({ id: "co_new", status: "active" }) },
    ]).restore;
    const env = makeEnv(db);
    await provisionSubMerchant(env, { tenantId: "tenant-a", spaceId: "space-a", ownerEmail: "a@example.com", businessName: "Biz A" });
    const row = await getSubMerchant(db as unknown as D1Database, "space-a");
    expect(row?.status).toBe("active");
    expect(row?.onboarding_url).toBeNull();
  });
});

// ── 2b. Verification gate: a wallet can receive revenue but not pay out until KYC completes ───

describe("KYC/onboarding gate blocks payouts, not revenue", () => {
  it("GET balance surfaces the onboarding_url only while status='awaiting_kyc'", async () => {
    const db = makeDb();
    await db.prepare(
      `INSERT INTO whop_sub_merchants (id, tenant_id, space_id, company_id, owner_email, status, onboarding_url, balance_cents)
       VALUES ('sm-a', 'tenant-a', 'space-a', 'co_a', 'a@example.com', 'awaiting_kyc', 'https://whop.com/onboard/xyz', 500)`
    ).run();
    const env = makeEnv(db);

    const res = await billingWorker.fetch(
      await walletReq("/billing/whop-wallet/balance?space_id=space-a"),
      env as never, execCtx
    );
    const j = await res.json() as { wallet: { status: string; onboarding_url: string | null; balance_cents: number } };
    expect(j.wallet.status).toBe("awaiting_kyc");
    expect(j.wallet.onboarding_url).toBe("https://whop.com/onboard/xyz");
    // Revenue already received is visible even though payouts aren't possible yet.
    expect(j.wallet.balance_cents).toBe(500);
  });

  it("a payout request is rejected with a clear message while status='awaiting_kyc'", async () => {
    const db = makeDb();
    await db.prepare(
      `INSERT INTO whop_sub_merchants (id, tenant_id, space_id, company_id, owner_email, status, onboarding_url, balance_cents)
       VALUES ('sm-a', 'tenant-a', 'space-a', 'co_a', 'a@example.com', 'awaiting_kyc', 'https://whop.com/onboard/xyz', 5000)`
    ).run();
    await db.prepare(
      `INSERT INTO payout_destinations (id, space_id, type, label, credential_name, status)
       VALUES ('dest-1', 'space-a', 'bank', 'Chase checking', 'cred-1', 'pending')`
    ).run();
    const env = makeEnv(db);

    const res = await billingWorker.fetch(
      await walletReq("/billing/whop-wallet/payouts", {
        method: "POST",
        body: { space_id: "space-a", destination_id: "dest-1", amount_cents: 1000 },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(409);
    const j = await res.json() as { error_code: string; message: string };
    expect(j.error_code).toBe("wallet_not_active");
    expect(j.message.toLowerCase()).toContain("verification");
  });

  it("a live status sync derives 'awaiting_kyc' from Whop's payouts_enabled:false, independent of Whop's own status string", async () => {
    const db = makeDb();
    await db.prepare(
      `INSERT INTO whop_sub_merchants (id, tenant_id, space_id, company_id, owner_email, status, balance_cents)
       VALUES ('sm-a', 'tenant-a', 'space-a', 'co_a', 'a@example.com', 'pending', 0)`
    ).run();
    restoreFetch = mockWhopFetch([
      { match: /sub_merchants\/co_a$/, method: "GET", respond: () => Response.json({ id: "co_a", balance_cents: 1200, currency: "usd", status: "pending", payouts_enabled: false }) },
    ]).restore;
    const env = makeEnv(db);

    const res = await billingWorker.fetch(
      await walletReq("/billing/whop-wallet/balance?space_id=space-a"),
      env as never, execCtx
    );
    const j = await res.json() as { wallet: { status: string; balance_cents: number } };
    expect(j.wallet.status).toBe("awaiting_kyc");
    expect(j.wallet.balance_cents).toBe(1200);
  });
});

// ── 3. Cross-business isolation ────────────────────────────────────────────────────────────────

describe("cross-business wallet isolation", () => {
  it("business A cannot read business B's wallet balance", async () => {
    const db = makeDb();
    await db.prepare(
      `INSERT INTO whop_sub_merchants (id, tenant_id, space_id, company_id, owner_email, status, balance_cents)
       VALUES ('sm-b', 'tenant-b', 'space-b', 'co_b', 'b@example.com', 'active', 5000)`
    ).run();
    const env = makeEnv(db);

    // tenant-a's token cannot read space-b (owned by tenant-b) — the guard resolves tenant
    // ownership from the space row itself, never trusts a cross-tenant query param.
    const res = await billingWorker.fetch(
      await walletReq("/billing/whop-wallet/balance?space_id=space-b", { tenantId: "tenant-a" }),
      env as never, execCtx
    );
    expect(res.status).toBe(404);
  });

  it("business A cannot request a payout from business B's wallet", async () => {
    const db = makeDb();
    await db.prepare(
      `INSERT INTO whop_sub_merchants (id, tenant_id, space_id, company_id, owner_email, status, balance_cents)
       VALUES ('sm-b', 'tenant-b', 'space-b', 'co_b', 'b@example.com', 'active', 5000)`
    ).run();
    await db.prepare(
      `INSERT INTO payout_destinations (id, space_id, type, label, credential_name, status)
       VALUES ('dest-b', 'space-b', 'bank', 'B bank', 'cred-b', 'verified')`
    ).run();
    const env = makeEnv(db);

    const res = await billingWorker.fetch(
      await walletReq("/billing/whop-wallet/payouts", {
        method: "POST", tenantId: "tenant-a",
        body: { space_id: "space-b", destination_id: "dest-b", amount_cents: 1000 },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(404);
  });
});

// ── 4. Webhook: idempotent recording, resolves company_id server-side ─────────────────────────

describe("POST /webhooks/whop", () => {
  it("records revenue exactly once for a duplicate delivery", async () => {
    const db = makeDb();
    await db.prepare(
      `INSERT INTO whop_sub_merchants (id, tenant_id, space_id, company_id, owner_email, status, balance_cents)
       VALUES ('sm-a', 'tenant-a', 'space-a', 'co_a', 'a@example.com', 'active', 0)`
    ).run();
    const env = makeEnv(db);

    const body = JSON.stringify({ id: "evt_dup_1", type: "payment.succeeded", data: { company_id: "co_a", final_amount: 2500, currency: "usd" } });
    const sig = await whopSign("whop-webhook-secret", body);
    const req = () => new Request("https://billing.naelao.com/webhooks/whop", { method: "POST", headers: { "whop-signature": sig }, body });

    const res1 = await billingWorker.fetch(req(), env as never, execCtx);
    expect(res1.status).toBe(200);
    const res2 = await billingWorker.fetch(req(), env as never, execCtx);
    expect(res2.status).toBe(200);

    const { results } = await db.prepare("SELECT * FROM wallet_transactions WHERE space_id = 'space-a'").all();
    expect(results?.length).toBe(1);
    expect((results?.[0] as { amount_cents: number }).amount_cents).toBe(2500);
  });

  it("rejects an unsigned/invalid webhook", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const body = JSON.stringify({ id: "evt_bad", type: "payment.succeeded", data: { company_id: "co_a", final_amount: 100 } });
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/webhooks/whop", { method: "POST", headers: { "whop-signature": "bogus" }, body }),
      env as never, execCtx
    );
    expect(res.status).toBe(401);
  });

  it("skips (200, no throw) an event for an unknown company id", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const body = JSON.stringify({ id: "evt_unknown", type: "payment.succeeded", data: { company_id: "co_never_provisioned", final_amount: 100 } });
    const sig = await whopSign("whop-webhook-secret", body);
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/webhooks/whop", { method: "POST", headers: { "whop-signature": sig }, body }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    const j = await res.json() as { skipped?: boolean };
    expect(j.skipped).toBe(true);
  });
});

// ── 5. Payout gating: first payout needs approval; verified destination executes directly ─────

describe("payout approval gating (safety invariant #5)", () => {
  async function seedActiveWallet(db: ReturnType<typeof makeDb>, balanceCents = 10_000) {
    await db.prepare(
      `INSERT INTO whop_sub_merchants (id, tenant_id, space_id, company_id, owner_email, status, balance_cents, currency)
       VALUES ('sm-a', 'tenant-a', 'space-a', 'co_a', 'a@example.com', 'active', ?, 'USD')`
    ).bind(balanceCents).run();
  }

  it("a payout to a NEW destination creates pending_approval and never calls Whop's withdrawal API", async () => {
    const db = makeDb();
    await seedActiveWallet(db);
    await db.prepare(
      `INSERT INTO payout_destinations (id, space_id, type, label, credential_name, status)
       VALUES ('dest-1', 'space-a', 'bank', 'Chase checking', 'cred-1', 'pending')`
    ).run();
    const { calls, restore } = mockWhopFetch([
      { match: /\/withdrawals$/, method: "POST", respond: () => Response.json({ id: "wd_1", status: "processing" }) },
      { match: /sub_merchants\/co_a$/, method: "GET", respond: () => Response.json({ id: "co_a", balance_cents: 10_000, currency: "usd", status: "active", payouts_enabled: true }) },
    ]);
    restoreFetch = restore;
    const env = makeEnv(db);

    const res = await billingWorker.fetch(
      await walletReq("/billing/whop-wallet/payouts", {
        method: "POST",
        body: { space_id: "space-a", destination_id: "dest-1", amount_cents: 2000 },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
    const j = await res.json() as { payout: { status: string } };
    expect(j.payout.status).toBe("pending_approval");
    // The withdrawal API must NEVER be called before owner approval.
    expect(calls.some((c) => /\/withdrawals$/.test(c.url))).toBe(false);

    const row = await db.prepare("SELECT status FROM payout_destinations WHERE id = 'dest-1'").first<{ status: string }>();
    expect(row?.status).toBe("pending"); // unchanged — only approval flips it to verified
  });

  it("the one-time approval link executes the withdrawal and marks the destination verified", async () => {
    const db = makeDb();
    await seedActiveWallet(db);
    await db.prepare(
      `INSERT INTO payout_destinations (id, space_id, type, label, credential_name, status)
       VALUES ('dest-1', 'space-a', 'bank', 'Chase checking', 'cred-1', 'pending')`
    ).run();
    const { calls, restore } = mockWhopFetch([
      { match: /\/withdrawals$/, method: "POST", respond: () => Response.json({ id: "wd_1", status: "processing" }) },
    ]);
    restoreFetch = restore;
    const env = makeEnv(db);

    // Create the pending_approval request directly (bypassing the email step for the test).
    const tokenHash = await (async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("plaintext-token"));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    })();
    await db.prepare(
      `INSERT INTO payout_requests (id, space_id, destination_id, amount_cents, status, approval_token_hash)
       VALUES ('req-1', 'space-a', 'dest-1', 2000, 'pending_approval', ?)`
    ).bind(tokenHash).run();

    // Wrong token is rejected.
    const badResp = await handlePayoutApproval(env, "req-1", "wrong-token");
    expect(badResp.status).toBe(401);
    expect(calls.length).toBe(0);

    // Correct token executes.
    const okResp = await handlePayoutApproval(env, "req-1", "plaintext-token");
    expect(okResp.status).toBe(200);
    expect(calls.some((c) => /\/withdrawals$/.test(c.url))).toBe(true);

    const request = await db.prepare("SELECT status, whop_withdrawal_id FROM payout_requests WHERE id = 'req-1'").first<{ status: string; whop_withdrawal_id: string }>();
    expect(request?.status).toBe("executed");
    expect(request?.whop_withdrawal_id).toBe("wd_1");
    const dest = await db.prepare("SELECT status FROM payout_destinations WHERE id = 'dest-1'").first<{ status: string }>();
    expect(dest?.status).toBe("verified");

    // Re-using the same token a second time must fail (single-use).
    const secondTry = await handlePayoutApproval(env, "req-1", "plaintext-token");
    expect(secondTry.status).toBe(410);
  });

  it("a payout to an already-verified destination executes directly (no second approval needed)", async () => {
    const db = makeDb();
    await seedActiveWallet(db);
    await db.prepare(
      `INSERT INTO payout_destinations (id, space_id, type, label, credential_name, status)
       VALUES ('dest-1', 'space-a', 'bank', 'Chase checking', 'cred-1', 'verified')`
    ).run();
    const { calls, restore } = mockWhopFetch([
      { match: /\/withdrawals$/, method: "POST", respond: () => Response.json({ id: "wd_2", status: "processing" }) },
    ]);
    restoreFetch = restore;
    const env = makeEnv(db);

    const res = await billingWorker.fetch(
      await walletReq("/billing/whop-wallet/payouts", {
        method: "POST",
        body: { space_id: "space-a", destination_id: "dest-1", amount_cents: 1500 },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
    const j = await res.json() as { payout: { status: string; withdrawal_id: string } };
    expect(j.payout.status).toBe("executed");
    expect(j.payout.withdrawal_id).toBe("wd_2");
    expect(calls.some((c) => /\/withdrawals$/.test(c.url))).toBe(true);
  });

  it("rejects a payout that exceeds the current balance (no partial payout)", async () => {
    const db = makeDb();
    await seedActiveWallet(db, 1000);
    await db.prepare(
      `INSERT INTO payout_destinations (id, space_id, type, label, credential_name, status)
       VALUES ('dest-1', 'space-a', 'bank', 'Chase checking', 'cred-1', 'verified')`
    ).run();
    const { calls, restore } = mockWhopFetch([
      { match: /sub_merchants\/co_a$/, method: "GET", respond: () => Response.json({ id: "co_a", balance_cents: 1000, currency: "usd", status: "active", payouts_enabled: true }) },
      { match: /\/withdrawals$/, method: "POST", respond: () => Response.json({ id: "wd_3", status: "processing" }) },
    ]);
    restoreFetch = restore;
    const env = makeEnv(db);

    const res = await billingWorker.fetch(
      await walletReq("/billing/whop-wallet/payouts", {
        method: "POST",
        body: { space_id: "space-a", destination_id: "dest-1", amount_cents: 999_999 },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(409);
    expect(calls.some((c) => /\/withdrawals$/.test(c.url))).toBe(false);
  });
});

// ── 6. No secret material lands in D1 ──────────────────────────────────────────────────────────

describe("secret hygiene", () => {
  it("the Whop master API key never appears in any whop_sub_merchants/payout row", async () => {
    const db = makeDb();
    restoreFetch = mockWhopFetch([
      { match: /\/v5\/platforms\/sub_merchants$/, method: "POST", respond: () => Response.json({ id: "co_new", status: "active" }) },
    ]).restore;
    const env = makeEnv(db);
    await provisionSubMerchant(env, { tenantId: "tenant-a", spaceId: "space-a", ownerEmail: "a@example.com", businessName: "Biz A" });

    const row = await getSubMerchant(db as unknown as D1Database, "space-a");
    expect(JSON.stringify(row)).not.toContain("whop_master_key");
  });
});
