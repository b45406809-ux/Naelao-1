import { describe, it, expect } from "vitest";

// ARCH-REVENUE-6: a builder's revenue share on a CHILD business's storefront sale. A business under
// a reseller builder sells a product; the wallet receives gross - naelao_fee - builder_fee, and the
// builder's slice is attributed to reseller_ledger (kind='builder_revenue_share'). A refund reverses
// BOTH deductions. Verified end-to-end through handleLemonSqueezyWebhook against a real fake-D1.

const SECRET = "test-platform-secret";

async function loadDb() {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { createFakeD1 } = await import("../stubs/d1-sqlite.js");
  const m = (f: string) => readFileSync(join(__dirname, "../../infra/migrations/", f), "utf8");
  const SPACES_SQL = `CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', parent_space_id TEXT);`;
  const fakeDb = createFakeD1([
    SPACES_SQL,
    m("0033_reseller_accounts.sql"),
    m("0035_commerce.sql"),
    m("0050_webhook_idempotency.sql"),
    m("0052_webhook_idempotency_event_type.sql"),
    m("0061_reseller_ledger_kind.sql"),
    m("0127_launchpad_order_seat_user_id.sql"),
  ]);
  await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES ('biz-1', 'child-tenant', 'active')").run();
  // child-tenant is a child business under parent builder tenant "builder-tenant".
  await fakeDb.prepare(
    "INSERT INTO tenant_hierarchy (child_tenant_id, parent_tenant_id, reseller_product_space_id, child_space_id, status) VALUES ('child-tenant','builder-tenant','prod-1','biz-1','active')"
  ).run();
  return fakeDb;
}

async function signed(rawBody: string): Promise<Request> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec_test"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://billing.naelao.com/webhooks/lemon-squeezy", { method: "POST", headers: { "X-Signature": sig }, body: rawBody });
}

function walletMock(settled: Array<{ op: string; cents: number }>) {
  return {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const body = await req.clone().json().catch(() => null) as { cents?: number } | null;
      if (req.url.includes("/wallet-project")) return Response.json({ project_id: "wallet-proj" });
      if (req.url.includes("/wallet/credit")) { settled.push({ op: "credit", cents: body?.cents ?? 0 }); return Response.json({ balance_cents: 0 }); }
      if (req.url.includes("/wallet/debit")) { settled.push({ op: "debit", cents: body?.cents ?? 0 }); return Response.json({ balance_cents: 0 }); }
      return Response.json({ ok: true });
    },
  };
}

function orderBody(kind: "order" | "refund", custom: Record<string, unknown>, orderId = "ord_1", total = 10000) {
  return JSON.stringify({
    meta: { event_name: kind === "refund" ? "order_refunded" : "order_created", custom_data: custom },
    data: { id: orderId, attributes: { total, currency: "USD", customer_id: "cust_1", ...(kind === "refund" ? { status: "refunded", refunded: true } : {}), custom_data: custom } },
  });
}

describe("ARCH-REVENUE-6: builder revenue share on a child business sale", () => {
  it("deducts naelao_fee AND builder_fee, settles the remainder, and attributes the builder slice", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const settled: Array<{ op: string; cents: number }> = [];
    const env = {
      PLATFORM_SECRET: SECRET, PLATFORM_DB: fakeDb, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_test",
      AGENTS_WORKER: { fetch: async () => new Response("{}") }, SPACES_WORKER: walletMock(settled),
    };
    // gross 10000, naelao 500bps=500, builder 1000bps=1000 → net 8500.
    const req = await signed(orderBody("order", { spaceId: "biz-1", product_id: "p1", fee_bps: "500", builder_fee_bps: "1000" }));
    const res = await handleLemonSqueezyWebhook(req, env as never);
    expect(res.status).toBe(200);

    const order = await fakeDb.prepare("SELECT fee_cents, builder_fee_cents, net_cents FROM launchpad_orders WHERE space_id = 'biz-1'").first() as { fee_cents: number; builder_fee_cents: number; net_cents: number };
    expect(order).toMatchObject({ fee_cents: 500, builder_fee_cents: 1000, net_cents: 8500 });
    expect(settled).toContainEqual({ op: "credit", cents: 8500 });

    const share = await fakeDb.prepare("SELECT margin_cents, kind, parent_tenant_id FROM reseller_ledger WHERE kind = 'builder_revenue_share'").first() as { margin_cents: number; kind: string; parent_tenant_id: string };
    expect(share).toMatchObject({ margin_cents: 1000, kind: "builder_revenue_share", parent_tenant_id: "builder-tenant" });
  });

  it("caps the builder fee at the 3000bps ceiling and never lets fees exceed gross", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const settled: Array<{ op: string; cents: number }> = [];
    const env = { PLATFORM_SECRET: SECRET, PLATFORM_DB: fakeDb, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_test", AGENTS_WORKER: { fetch: async () => new Response("{}") }, SPACES_WORKER: walletMock(settled) };
    // builder_fee_bps 9999 → clamped to 3000 (30% of 10000 = 3000). naelao 500. net = 6500.
    const req = await signed(orderBody("order", { spaceId: "biz-1", product_id: "p1", fee_bps: "500", builder_fee_bps: "9999" }));
    await handleLemonSqueezyWebhook(req, env as never);
    const order = await fakeDb.prepare("SELECT builder_fee_cents, net_cents FROM launchpad_orders WHERE space_id = 'biz-1'").first() as { builder_fee_cents: number; net_cents: number };
    expect(order.builder_fee_cents).toBe(3000);
    expect(order.net_cents).toBe(6500);
  });

  it("takes NO builder fee for a top-level space with no parent builder", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const { createFakeD1 } = await import("../stubs/d1-sqlite.js");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const m = (f: string) => readFileSync(join(__dirname, "../../infra/migrations/", f), "utf8");
    const fakeDb = createFakeD1([
      `CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', parent_space_id TEXT);`,
      m("0033_reseller_accounts.sql"), m("0035_commerce.sql"), m("0050_webhook_idempotency.sql"), m("0052_webhook_idempotency_event_type.sql"), m("0061_reseller_ledger_kind.sql"), m("0127_launchpad_order_seat_user_id.sql"),
    ]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES ('top-1', 'builder-tenant', 'active')").run();
    const settled: Array<{ op: string; cents: number }> = [];
    const env = { PLATFORM_SECRET: SECRET, PLATFORM_DB: fakeDb, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_test", AGENTS_WORKER: { fetch: async () => new Response("{}") }, SPACES_WORKER: walletMock(settled) };
    const req = await signed(orderBody("order", { spaceId: "top-1", product_id: "p1", fee_bps: "500", builder_fee_bps: "1000" }));
    await handleLemonSqueezyWebhook(req, env as never);
    const order = await fakeDb.prepare("SELECT builder_fee_cents, net_cents FROM launchpad_orders WHERE space_id = 'top-1'").first() as { builder_fee_cents: number; net_cents: number };
    expect(order.builder_fee_cents).toBe(0); // no parent builder → no builder share
    expect(order.net_cents).toBe(9500);      // only the naelao fee comes out
  });

  it("reverses BOTH the wallet net and the builder share on a refund", async () => {
    const { handleLemonSqueezyWebhook } = await import("../../workers/billing/src/lemon-squeezy.js");
    const fakeDb = await loadDb();
    const settled: Array<{ op: string; cents: number }> = [];
    const env = { PLATFORM_SECRET: SECRET, PLATFORM_DB: fakeDb, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_test", AGENTS_WORKER: { fetch: async () => new Response("{}") }, SPACES_WORKER: walletMock(settled) };
    const custom = { spaceId: "biz-1", product_id: "p1", fee_bps: "500", builder_fee_bps: "1000" };
    await handleLemonSqueezyWebhook(await signed(orderBody("order", custom, "ord_9")), env as never);
    await handleLemonSqueezyWebhook(await signed(orderBody("refund", custom, "ord_9")), env as never);

    // Wallet: credited 8500 then debited 8500 back.
    expect(settled).toContainEqual({ op: "credit", cents: 8500 });
    expect(settled).toContainEqual({ op: "debit", cents: 8500 });
    // Builder share nets to zero (+1000 then -1000).
    const net = await fakeDb.prepare("SELECT COALESCE(SUM(margin_cents),0) AS n FROM reseller_ledger WHERE kind = 'builder_revenue_share'").first() as { n: number };
    expect(net.n).toBe(0);
  });
});
