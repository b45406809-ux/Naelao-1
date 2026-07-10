import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { handleLemonSqueezyWebhook } from "../../workers/billing/src/lemon-squeezy.js";
import type { LemonSqueezyEnv } from "../../workers/billing/src/lemon-squeezy.js";

// S0.3: before this pass, handleLemonSqueezyWebhook had no top-level idempotency — a Lemon
// Squeezy retry (any non-2xx response or timeout triggers one) re-ran the WHOLE handler,
// including a plain (non-unique-constrained) reseller_ledger INSERT (double-counting the
// wholesale invoice on every retry) and wakeAgent (duplicate fulfillment/welcome emails).
// launchpad_orders had its own unique index, but the key fed into it was a synthetic
// ${type}:${customerId}:${gross}:${productId} string — two genuinely distinct same-price
// purchases collided and the second was silently dropped. This suite exercises the REAL SQL
// (via node:sqlite), not a hand-rolled always-succeeds mock, to prove the fix end-to-end.

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
// P0-5 follow-on: the (provider, event_id) uniqueness alone let a later, genuinely different
// event for the same LS resource (e.g. order_refunded sharing an order_created's data.id) get
// silently treated as a duplicate of the first. See 0052's own header comment for the full story.
const WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0052_webhook_idempotency_event_type.sql"), "utf8");

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeOrderPaidBody(spaceId: string, orderId: string, customData: Record<string, string> = {}): string {
  return JSON.stringify({
    meta: { event_name: "order_created", custom_data: { spaceId, ...customData } },
    data: { id: orderId, attributes: { total: 1999, currency: "USD", customer_id: "cust_1", custom_data: { spaceId, ...customData } } },
  });
}

function makeSubscriptionUpdatedBody(spaceId: string, subId: string): string {
  return JSON.stringify({
    meta: { event_name: "subscription_updated", custom_data: { spaceId } },
    data: { id: subId, attributes: { total: 1999, currency: "USD", customer_id: "cust_1", custom_data: { spaceId } } },
  });
}

function makeEnv(db: D1Database, agentsFetch: (req: Request) => Promise<Response>): LemonSqueezyEnv {
  return {
    LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PLATFORM_SECRET,
    PLATFORM_DB: db,
    AGENTS_WORKER: { fetch: agentsFetch } as unknown as Fetcher,
  };
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

describe("Lemon Squeezy webhook — exactly-once (S0.3)", () => {
  it("replaying the same event twice wakes the agent only once", async () => {
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION, LEDGER_KIND_MIGRATION]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("space1", "tenant1").run();

    const agentsFetch = vi.fn(async () => new Response("{}"));
    const env = makeEnv(fakeDb as unknown as D1Database, agentsFetch);
    const raw = makeOrderPaidBody("space1", "ord_dup_1");

    const res1 = await post(raw, env);
    const res2 = await post(raw, env);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect((await res2.json()) as { duplicate?: boolean }).toMatchObject({ duplicate: true });
    expect(agentsFetch).toHaveBeenCalledTimes(1);
  });

  it("replaying the same event twice records exactly one launchpad_orders row", async () => {
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION, LEDGER_KIND_MIGRATION]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("space1", "tenant1").run();

    const env = makeEnv(fakeDb as unknown as D1Database, async () => new Response("{}"));
    const raw = makeOrderPaidBody("space1", "ord_dup_2", { product_id: "prod_a" });

    await post(raw, env);
    await post(raw, env);

    const { results } = await fakeDb.prepare("SELECT * FROM launchpad_orders WHERE space_id = ?").bind("space1").all();
    expect(results).toHaveLength(1);
  });

  it("two genuinely distinct same-price purchases of the same product both record (no key collision)", async () => {
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION, LEDGER_KIND_MIGRATION]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("space1", "tenant1").run();

    const env = makeEnv(fakeDb as unknown as D1Database, async () => new Response("{}"));
    // Same product, same price, same customer — but two REAL distinct LS order ids.
    await post(makeOrderPaidBody("space1", "ord_distinct_1", { product_id: "prod_a" }), env);
    await post(makeOrderPaidBody("space1", "ord_distinct_2", { product_id: "prod_a" }), env);

    const { results } = await fakeDb.prepare("SELECT * FROM launchpad_orders WHERE space_id = ?").bind("space1").all();
    expect(results).toHaveLength(2);
  });

  it("replaying a non-order event (subscription.updated, no order/ledger side effect) still only wakes the agent once", async () => {
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION, LEDGER_KIND_MIGRATION]);
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("space1", "tenant1").run();

    const agentsFetch = vi.fn(async () => new Response("{}"));
    const env = makeEnv(fakeDb as unknown as D1Database, agentsFetch);
    const raw = makeSubscriptionUpdatedBody("space1", "sub_dup_1");

    await post(raw, env);
    await post(raw, env);

    expect(agentsFetch).toHaveBeenCalledTimes(1);
  });

  it("replaying a reseller-attributed event twice yields exactly one reseller_ledger row", async () => {
    const fakeDb = createFakeD1([SPACES_SQL, RESELLER_MIGRATION, COMMERCE_MIGRATION, WEBHOOK_IDEMPOTENCY_MIGRATION, WEBHOOK_IDEMPOTENCY_EVENT_TYPE_MIGRATION, LEDGER_KIND_MIGRATION]);
    // Child tenant under a reseller parent — set up the hierarchy + reseller_accounts config.
    await fakeDb.prepare("INSERT INTO spaces (id, tenant_id, status) VALUES (?, ?, 'active')").bind("child-space", "child-tenant").run();
    await fakeDb.prepare(
      "INSERT INTO reseller_accounts (tenant_id, product_space_id, billing_relationship, wholesale_cents, referral_share_pct, status) VALUES (?, ?, 'reseller', 500, 0, 'active')"
    ).bind("parent-tenant", "root-space").run();
    await fakeDb.prepare(
      "INSERT INTO tenant_hierarchy (child_tenant_id, parent_tenant_id, reseller_product_space_id, child_space_id, status) VALUES (?, ?, ?, ?, 'active')"
    ).bind("child-tenant", "parent-tenant", "root-space", "child-space").run();

    const env = makeEnv(fakeDb as unknown as D1Database, async () => new Response("{}"));
    const raw = makeOrderPaidBody("child-space", "ord_reseller_1");

    await post(raw, env);
    await post(raw, env);

    const { results } = await fakeDb.prepare("SELECT * FROM reseller_ledger WHERE child_space_id = ?").bind("child-space").all();
    expect(results).toHaveLength(1);
  });
});
