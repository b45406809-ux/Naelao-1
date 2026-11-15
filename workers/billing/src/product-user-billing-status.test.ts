import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

function database(accountFound = true) {
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return { bind(...args: unknown[]) {
        queries.push({ sql, args });
        return {
          async first() {
            return accountFound && sql.includes("LEFT JOIN product_user_subscriptions")
              ? { plan_tier: "growth", status: "past_due", current_period_end: "2026-12-01T00:00:00.000Z", provider: "lemon_squeezy", provider_subscription_id: "private-subscription-id" }
              : null;
          },
          async all() {
            return sql.includes("FROM billing_dunning_outbox")
              ? { results: [{ status: "pending", attempt_count: 2, updated_at: "2026-11-14T00:00:00.000Z", sent_at: null }] }
              : { results: [{ provider_outcome: "provider_accepted", attempt_count: 2, last_attempt_at: "2026-11-14T00:00:00.000Z", accepted_at: "2026-11-14T00:00:00.000Z" }] };
          },
        };
      } };
    },
  } as unknown as D1Database;
  return { db, queries };
}

async function request(db: D1Database, authorized: boolean, body = { product_id: "product-1", end_user_id: "user-1" }) {
  const secret = "billing-status-test-secret";
  const token = authorized ? await mintInternalToken(secret, "org-1") : "invalid";
  return worker.fetch!(new Request("https://billing.test/internal/product-user-billing-status", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "org-1", "x-naelao-internal-token": token },
    body: JSON.stringify(body),
  }), { PLATFORM_SECRET: secret, PLATFORM_DB: db } as never, {} as never);
}

describe("Product-user billing status scope", () => {
  it("requires an internal tenant HMAC before querying subscription data", async () => {
    const context = database();
    expect((await request(context.db, false)).status).toBe(403);
    expect(context.queries).toHaveLength(0);
  });

  it("returns only the requested Product user's subscription, queue handoff, and provider outcome", async () => {
    const context = database();
    const response = await request(context.db, true);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toEqual({
      subscription: { plan_tier: "growth", status: "past_due", current_period_end: "2026-12-01T00:00:00.000Z" },
      notifications: [{ provider_outcome: "provider_accepted", attempt_count: 2, last_attempt_at: "2026-11-14T00:00:00.000Z", accepted_at: "2026-11-14T00:00:00.000Z" }],
      dispatches: [{ status: "pending", attempt_count: 2, updated_at: "2026-11-14T00:00:00.000Z", sent_at: null }],
    });
    expect(JSON.stringify(payload)).not.toContain("private-subscription-id");
    expect(JSON.stringify(payload)).not.toContain("provider_receipt_id");
    expect(context.queries[0]?.args).toEqual(["product-1", "org-1", "user-1"]);
    expect(context.queries[1]?.args).toEqual(["org-1", "product-1", "user-1", "lemon_squeezy", "private-subscription-id"]);
    expect(context.queries[1]?.sql).toContain("d.subscription_scope='product_user_subscription'");
    expect(context.queries[2]?.args).toEqual(["org-1", "lemon_squeezy", "private-subscription-id", "product-1", "user-1"]);
    expect(context.queries[2]?.sql).toContain("json_valid(o.payload_json)");
    expect(context.queries[2]?.sql).toContain("o.tenant_id=? AND o.provider=? AND o.subscription_id=?");
  });

  it("rejects malformed identity before querying", async () => {
    const context = database();
    expect((await request(context.db, true, { product_id: "product-1", end_user_id: "../other-user" })).status).toBe(400);
    expect(context.queries).toHaveLength(0);
  });

  it("does not return status rows for a product/user pair outside the verified tenant lookup", async () => {
    const context = database(false);
    const response = await request(context.db, true);
    expect(response.status).toBe(404);
    expect(context.queries).toHaveLength(1);
    expect(context.queries[0]?.args).toEqual(["product-1", "org-1", "user-1"]);
  });
});
