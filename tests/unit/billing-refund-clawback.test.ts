import { describe, it, expect } from "vitest";
import { mintInternalToken } from "@naelao/http";

// F-21/F-28 (reseller attribution kind allowlist), F-29 (refund clawback for wallet top-ups,
// credit packs, and revenue-cut surcharges), F-30 (idempotency keys derived from the LS order id).
// These exercise handleLemonSqueezyWebhook end-to-end against a real fake-D1 with the same
// migrations the surcharge suite loads.

const SECRET = "test-platform-secret";

async function loadDb() {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { createFakeD1 } = await import("../stubs/d1-sqlite.js");
  const SPACES_SQL = `CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');`;
  const m = (f: string) => readFileSync(join(__dirname, "../../infra/migrations/", f), "utf8");
  const fakeDb = createFakeD1([
    SPACES_SQL,
    m("0033_reseller_accounts.sql"),
    m("0035_commerce.sql"),
    m("0050_webhook_idempotency.sql"),
    m("0052_webhook_idempotency_event_type.sql"),
  ]);
  await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("space-1", "tenant-1").run();
  return fakeDb;
}

async function signedWebhook(rawBody: string, webhookSecret: string): Promise<Request> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://billing.naelao.com/webhooks/lemon-squeezy", { method: "POST", headers: { "X-Signature": sig }, body: rawBody });
}

function refundBody(custom: Record<string, unknown>, orderId = "ord_1") {
  return JSON.stringify({
    meta: { event_name: "order_refunded", custom_data: custom },
    data: { id: orderId, attributes: { total: 5000, currency: "USD", customer_id: "cust_1", refunded: true, status: "refunded", custom_data: custom } },
  });
}

describe("F-29: refund clawback routes by original checkout kind", () => {
  it("debits the wallet on a refunded wallet_topup", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const calls: Array<{ url: string; body: unknown }> = [];
    const spacesWorker = {
      async fetch(reqInput: Request | string, init?: RequestInit) {
        const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
        const body = await req.clone().json().catch(() => null);
        calls.push({ url: req.url, body });
        return Response.json({ balance_cents: 0 });
      },
    };
    const env = {
      PLATFORM_SECRET: SECRET, PLATFORM_DB: fakeDb, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_test",
      AGENTS_WORKER: { fetch: async () => new Response("{}") }, SPACES_WORKER: spacesWorker,
    };
    const req = await signedWebhook(refundBody({ spaceId: "space-1", kind: "wallet_topup", project_id: "wallet-proj", cents: 5000 }), "whsec_test");
    const res = await handleLemonSqueezyWebhook(req, env as never);
    expect(res.status).toBe(200);
    const debit = calls.find((c) => c.url.includes("/wallet/debit"));
    expect(debit).toBeDefined();
    expect(debit!.body).toMatchObject({ cents: 5000, reason: "refund_clawback", idempotency_key: "refund:ord_1" });
  });

  it("claws back credits on a refunded credit_pack", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const calls: Array<{ url: string; body: unknown }> = [];
    const spacesWorker = {
      async fetch(reqInput: Request | string, init?: RequestInit) {
        const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
        const body = await req.clone().json().catch(() => null);
        calls.push({ url: req.url, body });
        return Response.json({ balance_credits: 0 });
      },
    };
    const env = {
      PLATFORM_SECRET: SECRET, PLATFORM_DB: fakeDb, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_test",
      AGENTS_WORKER: { fetch: async () => new Response("{}") }, SPACES_WORKER: spacesWorker,
    };
    const req = await signedWebhook(refundBody({ spaceId: "space-1", kind: "credit_pack", product_space_id: "space-1", end_user_id: "alice", credits: 1000 }), "whsec_test");
    const res = await handleLemonSqueezyWebhook(req, env as never);
    expect(res.status).toBe(200);
    const clawback = calls.find((c) => c.url.includes("/internal/credit-packs/clawback"));
    expect(clawback).toBeDefined();
    expect(clawback!.body).toMatchObject({ end_user_id: "alice", credits: 1000, idempotency_key: "refund:ord_1" });
  });

  it("un-marks periods on a refunded revenue_cut_surcharge", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const calls: Array<{ url: string; body: unknown }> = [];
    const spacesWorker = {
      async fetch(reqInput: Request | string, init?: RequestInit) {
        const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
        const body = await req.clone().json().catch(() => null);
        calls.push({ url: req.url, body });
        return Response.json({ unbilled_periods: [] });
      },
    };
    const env = {
      PLATFORM_SECRET: SECRET, PLATFORM_DB: fakeDb, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_test",
      AGENTS_WORKER: { fetch: async () => new Response("{}") }, SPACES_WORKER: spacesWorker,
    };
    const req = await signedWebhook(refundBody({ spaceId: "space-1", kind: "revenue_cut_surcharge", periods: "2026-06,2026-07" }), "whsec_test");
    const res = await handleLemonSqueezyWebhook(req, env as never);
    expect(res.status).toBe(200);
    const unmark = calls.find((c) => c.url.includes("/revenue-tracking/unmark-billed"));
    expect(unmark).toBeDefined();
    expect(unmark!.body).toMatchObject({ periods: ["2026-06", "2026-07"] });
  });
});

describe("F-21/F-28: reseller attribution excludes platform-revenue kinds", () => {
  async function runWalletTopupUnderReseller(): Promise<{ ledgerRows: number }> {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    // Make space-1's tenant a child under an active reseller with a referral share.
    await fakeDb.prepare("INSERT INTO tenant_hierarchy (child_tenant_id, parent_tenant_id, reseller_product_space_id, child_space_id, status) VALUES (?, ?, ?, ?, 'active')").bind("tenant-1", "parent-t", "space-1", "space-1").run();
    await fakeDb.prepare(
      "INSERT INTO reseller_accounts (tenant_id, product_space_id, billing_relationship, wholesale_cents, referral_share_pct, status) VALUES (?, ?, 'referral', NULL, ?, 'active')"
    ).bind("parent-t", "space-1", 20).run();

    const spacesWorker = { async fetch() { return Response.json({ balance_cents: 0, project_id: null }); } };
    const env = {
      PLATFORM_SECRET: SECRET, PLATFORM_DB: fakeDb, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_test",
      AGENTS_WORKER: { fetch: async () => new Response("{}") }, SPACES_WORKER: spacesWorker,
    };
    const custom = { spaceId: "space-1", kind: "wallet_topup", project_id: "wallet-proj", cents: 10000 };
    const rawBody = JSON.stringify({
      meta: { event_name: "order_created", custom_data: custom },
      data: { id: "ord_topup_1", attributes: { total: 10000, currency: "USD", customer_id: "cust_1", custom_data: custom } },
    });
    const req = await signedWebhook(rawBody, "whsec_test");
    await handleLemonSqueezyWebhook(req, env as never);
    const row = await fakeDb.prepare("SELECT COUNT(*) AS n FROM reseller_ledger").first() as { n: number };
    return { ledgerRows: row.n };
  }

  it("accrues NO reseller margin on a wallet_topup by a child business", async () => {
    const { ledgerRows } = await runWalletTopupUnderReseller();
    expect(ledgerRows).toBe(0);
  });
});
