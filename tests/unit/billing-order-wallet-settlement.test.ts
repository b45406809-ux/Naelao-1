import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { handleLemonSqueezyWebhook } from "../../workers/billing/src/lemon-squeezy.js";
import type { LemonSqueezyEnv } from "../../workers/billing/src/lemon-squeezy.js";
import { verifyInternalToken } from "@naelao/http";

// P0-5: a storefront sale's net proceeds (launchpad_orders.net_cents) used to sit in that row and
// go nowhere — Naelao's own Lemon Squeezy account kept 100% of every sale, the seller got a
// database row and nothing else. This settles net_cents into the SELLING space's own
// auto-provisioned wallet (the same wallet P0-2's gate checks before running that space's agent),
// and claws it back on a refund. Uses the real SQL (node:sqlite via createFakeD1) + real
// migrations, same rigor as webhook-idempotency.test.ts, plus a mocked SPACES_WORKER for the
// wallet-project/credit/debit calls.

const WEBHOOK_SECRET = "test-ls-webhook-secret";
const PLATFORM_SECRET = "test-platform-secret";

const SPACES_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
  );
`;
const RESELLER_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0033_reseller_accounts.sql"), "utf8");
const COMMERCE_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0035_commerce.sql"), "utf8");
const LEDGER_KIND_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0061_reseller_ledger_kind.sql"), "utf8");
const WEBHOOK_IDEMPOTENCY_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0050_webhook_idempotency.sql"), "utf8");
const WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0052_webhook_idempotency_event_type.sql"), "utf8");

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeOrderPaidBody(spaceId: string, orderId: string, productId: string, totalCents = 1999): string {
  return JSON.stringify({
    meta: { event_name: "order_created", custom_data: { spaceId, product_id: productId } },
    data: { id: orderId, attributes: { total: totalCents, currency: "USD", customer_id: "cust_1", custom_data: { spaceId, product_id: productId } } },
  });
}

function makeOrderRefundedBody(spaceId: string, orderId: string, productId: string, totalCents = 1999): string {
  // order_refunded is a status transition on the SAME underlying LS order resource — same data.id
  // as the original order_created event for that order.
  return JSON.stringify({
    meta: { event_name: "order_refunded", custom_data: { spaceId, product_id: productId } },
    data: { id: orderId, attributes: { total: totalCents, currency: "USD", customer_id: "cust_1", custom_data: { spaceId, product_id: productId } } },
  });
}

async function post(raw: string, env: LemonSqueezyEnv): Promise<Response> {
  return handleLemonSqueezyWebhook(
    new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
      method: "POST",
      headers: { "X-Signature": await signBody(raw) },
      body: raw,
    }),
    env
  );
}

interface WalletCall { url: string; method: string; body: unknown; headers: Record<string, string> }

function makeSpacesWorker(opts: { walletProjectId?: string | null; debitOk?: boolean } = {}) {
  const { walletProjectId = "wallet-proj-1", debitOk = true } = opts;
  const calls: WalletCall[] = [];
  const fetcher = {
    async fetch(reqInput: Request | string, init?: RequestInit): Promise<Response> {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const body = await req.clone().json().catch(() => null);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      calls.push({ url: req.url, method: req.method, body, headers });

      if (/\/wallet-project$/.test(req.url)) {
        return Response.json({ project_id: walletProjectId });
      }
      if (/\/wallet\/credit$/.test(req.url)) {
        return Response.json({ balance_cents: 1899 }, { status: 201 });
      }
      if (/\/wallet\/debit$/.test(req.url)) {
        return debitOk
          ? Response.json({ balance_cents: 0 }, { status: 201 })
          : Response.json({ error_code: "insufficient_balance", balance_cents: 0 }, { status: 402 });
      }
      return new Response("not found", { status: 404 });
    },
  };
  return { fetcher, calls };
}

function makeEnv(db: D1Database, spacesWorker: ReturnType<typeof makeSpacesWorker>["fetcher"]): LemonSqueezyEnv {
  return {
    LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PLATFORM_SECRET,
    PLATFORM_DB: db,
    AGENTS_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
    SPACES_WORKER: spacesWorker as unknown as Fetcher,
  };
}

describe("Lemon Squeezy webhook — storefront sale settles to the seller's own wallet (P0-5)", () => {
  it("credits net_cents (gross minus platform fee) to the space's wallet on a new order", async () => {
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION, LEDGER_KIND_MIGRATION]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("space1", "tenant1").run();

    const { fetcher, calls } = makeSpacesWorker();
    const env = makeEnv(fakeDb as unknown as D1Database, fetcher);
    await post(makeOrderPaidBody("space1", "ord1", "prod_a", 1999), env);

    const creditCall = calls.find((c) => /\/wallet\/credit$/.test(c.url));
    expect(creditCall).toBeDefined();
    // LAUNCHPAD_FEE_BPS defaults to 500 (5%) when unset — fee = round(1999 * 0.05) = 100, net = 1899.
    expect(creditCall!.body).toMatchObject({ cents: 1899, reason: "sale_settlement" });
    expect(await verifyInternalToken(creditCall!.headers["x-naelao-internal-token"], "tenant1", PLATFORM_SECRET)).toBe(true);
  });

  it("never double-settles the same order on a replayed webhook delivery", async () => {
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION, LEDGER_KIND_MIGRATION]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("space1", "tenant1").run();

    const { fetcher, calls } = makeSpacesWorker();
    const env = makeEnv(fakeDb as unknown as D1Database, fetcher);
    const raw = makeOrderPaidBody("space1", "ord_replay", "prod_a");
    await post(raw, env);
    await post(raw, env); // duplicate delivery — top-level dedup should no-op the whole handler

    expect(calls.filter((c) => /\/wallet\/credit$/.test(c.url))).toHaveLength(1);
  });

  it("degrades honestly (never blocks order recording) when the space has no wallet project", async () => {
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION, LEDGER_KIND_MIGRATION]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("space1", "tenant1").run();

    const { fetcher } = makeSpacesWorker({ walletProjectId: null });
    const env = makeEnv(fakeDb as unknown as D1Database, fetcher);
    const res = await post(makeOrderPaidBody("space1", "ord_nowallet", "prod_a"), env);
    expect(res.status).toBe(200);

    const { results } = await fakeDb.prepare("SELECT * FROM launchpad_orders WHERE space_id = ?").bind("space1").all();
    expect(results).toHaveLength(1); // order still recorded even though settlement had nowhere to go
  });
});

describe("Lemon Squeezy webhook — refund claws back the settled amount (P0-5)", () => {
  it("debits the ORIGINAL order's net_cents from the wallet and marks the order refunded", async () => {
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION, LEDGER_KIND_MIGRATION]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("space1", "tenant1").run();

    const { fetcher, calls } = makeSpacesWorker();
    const env = makeEnv(fakeDb as unknown as D1Database, fetcher);

    await post(makeOrderPaidBody("space1", "ord_refund_1", "prod_a", 1999), env);
    await post(makeOrderRefundedBody("space1", "ord_refund_1", "prod_a", 1999), env);

    const debitCall = calls.find((c) => /\/wallet\/debit$/.test(c.url));
    expect(debitCall).toBeDefined();
    expect(debitCall!.body).toMatchObject({ cents: 1899, reason: "refund_clawback" });

    const order = await fakeDb.prepare("SELECT status FROM launchpad_orders WHERE provider_event_id = ?").bind("ord_refund_1").first<{ status: string }>();
    expect(order?.status).toBe("refunded");
  });

  it("is idempotent — replaying the same refund delivery only debits the wallet once", async () => {
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION, LEDGER_KIND_MIGRATION]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("space1", "tenant1").run();

    const { fetcher, calls } = makeSpacesWorker();
    const env = makeEnv(fakeDb as unknown as D1Database, fetcher);

    await post(makeOrderPaidBody("space1", "ord_refund_2", "prod_a"), env);
    const refundRaw = makeOrderRefundedBody("space1", "ord_refund_2", "prod_a");
    await post(refundRaw, env);
    await post(refundRaw, env); // Lemon Squeezy retries a refund delivery the same way it retries any other

    expect(calls.filter((c) => /\/wallet\/debit$/.test(c.url))).toHaveLength(1);
  });

  it("never touches the wallet for a refund on an order this platform never recorded", async () => {
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION, LEDGER_KIND_MIGRATION]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("space1", "tenant1").run();

    const { fetcher, calls } = makeSpacesWorker();
    const env = makeEnv(fakeDb as unknown as D1Database, fetcher);
    // No prior order_created for "ord_unknown" — an unrecognized refund must not guess a wallet.
    await post(makeOrderRefundedBody("space1", "ord_unknown", "prod_a"), env);

    expect(calls.filter((c) => /\/wallet\/debit$/.test(c.url))).toHaveLength(0);
  });

  it("a refund clawback that exceeds the wallet's current balance fails honestly (402), does not go negative", async () => {
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION, LEDGER_KIND_MIGRATION]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("space1", "tenant1").run();

    const { fetcher } = makeSpacesWorker({ debitOk: false });
    const env = makeEnv(fakeDb as unknown as D1Database, fetcher);
    await post(makeOrderPaidBody("space1", "ord_refund_3", "prod_a"), env);
    const res = await post(makeOrderRefundedBody("space1", "ord_refund_3", "prod_a"), env);

    // The webhook itself still 200s — a wallet-side shortfall never fails the LS delivery.
    expect(res.status).toBe(200);
    // But the order IS still marked refunded — LS's own refund is a fact regardless of whether
    // Naelao could claw back the wallet balance.
    const order = await fakeDb.prepare("SELECT status FROM launchpad_orders WHERE provider_event_id = ?").bind("ord_refund_3").first<{ status: string }>();
    expect(order?.status).toBe("refunded");
  });
});

describe("Lemon Squeezy webhook — transient settlement failure retries instead of losing revenue", () => {
  // A wallet CREDIT (sale settlement) that fails transiently used to be swallowed with a 200, so
  // Lemon Squeezy never retried and the seller silently lost the proceeds. Now it returns 500 and
  // releases the exactly-once reservation, so the LS retry re-settles (idempotency_key → safe).
  function makeFlakyCreditWorker(failFirst: number) {
    let creditCalls = 0;
    const fetcher = {
      async fetch(reqInput: Request | string, init?: RequestInit): Promise<Response> {
        const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
        if (/\/wallet-project$/.test(req.url)) return Response.json({ project_id: "wallet-proj-1" });
        if (/\/wallet\/credit$/.test(req.url)) {
          creditCalls++;
          return creditCalls <= failFirst
            ? new Response("upstream boom", { status: 503 })
            : Response.json({ balance_cents: 1899 }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      },
    };
    return { fetcher, get creditCalls() { return creditCalls; } };
  }

  it("first delivery 500s and releases the event; the retry settles (no lost revenue)", async () => {
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION, LEDGER_KIND_MIGRATION]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id) VALUES ('space-1', 'tenant-1')").run();
    const worker = makeFlakyCreditWorker(1); // credit fails once, then succeeds
    const env = makeEnv(fakeDb, worker.fetcher as unknown as Fetcher);
    const raw = makeOrderPaidBody("space-1", "ord_flaky", "prod-1", 1999);

    // 1st delivery: credit fails transiently → 500, and the event is released for retry.
    const first = await post(raw, env);
    expect(first.status).toBe(500);
    const marker = await fakeDb.prepare("SELECT COUNT(*) AS n FROM processed_webhook_events WHERE event_id = 'ord_flaky'").first<{ n: number }>();
    expect(marker?.n).toBe(0); // reservation released → LS retry won't be deduped away

    // 2nd delivery (the LS retry): credit succeeds → 200, and settlement happened exactly once.
    const second = await post(raw, env);
    expect(second.status).toBe(200);
    expect(worker.creditCalls).toBe(2); // one failed attempt + one successful
  });
});
