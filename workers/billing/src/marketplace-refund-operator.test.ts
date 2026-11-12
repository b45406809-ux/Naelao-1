import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { BillingEnv } from "./index.js";
import { registerMarketplaceLicenseRoutes } from "./marketplace-licenses.js";

const operatorKey = "marketplace-refund-operator-secret";

function harness(results: unknown[] = [{ id: "case-a", provider_order_id: "provider-order-private", tenant_id: "tenant-a",
  listing_id: "listing-a", state: "review_required", review_reason: "policy_pending" }]) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(...values: unknown[]) {
          queries.push({ sql, values });
          return {
            async all() {
              return { results };
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          };
        },
      };
      return statement;
    },
  };
  const app = new Hono<{ Bindings: BillingEnv }>();
  registerMarketplaceLicenseRoutes(app);
  return { app, db, queries };
}

function env(db: unknown, key = operatorKey) {
  return { PLATFORM_SECRET: "platform-secret", PLATFORM_DB: db, MANAGED_SERVICES_OPERATOR_SECRET: key } as BillingEnv;
}

describe("marketplace refund operator review API", () => {
  it("requires the dedicated operator secret and an attributable operator ID", async () => {
    const h = harness();
    const denied = await h.app.request("/internal/marketplace/operator/refund-cases", { headers: { "x-managed-services-operator-key": "wrong" } }, env(h.db));
    expect(denied.status).toBe(403);
    const unidentified = await h.app.request("/internal/marketplace/operator/refund-cases", {
      headers: { "x-managed-services-operator-key": operatorKey },
    }, env(h.db));
    expect(unidentified.status).toBe(400);
    expect(h.queries).toHaveLength(0);
  });

  it("lists scoped cases read-only and writes a minimal operator audit row", async () => {
    const h = harness();
    const response = await h.app.request("/internal/marketplace/operator/refund-cases?tenant_id=tenant-a&state=review_required&limit=20&offset=40", {
      headers: { "x-managed-services-operator-key": operatorKey, "x-managed-services-operator-id": "ops-user-4" },
    }, env(h.db));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operator_id: "ops-user-4", offset: 40, limit: 20, has_more: false,
      policy: "review_only_no_automatic_license_or_earning_reversal",
      cases: [{ id: "case-a", state: "review_required", review_reason: "policy_pending" }],
    });
    expect(h.queries).toHaveLength(2);
    expect(h.queries[0]?.sql).toContain("WHERE tenant_id=? AND state=?");
    expect(h.queries[0]?.values).toEqual(["tenant-a", "review_required", 21, 40]);
    expect(h.queries[1]?.sql).toContain("INSERT INTO audit_log");
    expect(h.queries[1]?.values[1]).toBe("tenant-a");
    expect(h.queries[1]?.values[2]).toBe("ops-user-4");
    expect(JSON.stringify(h.queries[1]?.values)).not.toContain("provider-order-private");
  });

  it("rejects unsafe scope, state, and pagination without querying the ledger", async () => {
    const h = harness(), headers = { "x-managed-services-operator-key": operatorKey, "x-managed-services-operator-id": "ops-user-4" };
    expect((await h.app.request("/internal/marketplace/operator/refund-cases?tenant_id=../other", { headers }, env(h.db))).status).toBe(400);
    expect((await h.app.request("/internal/marketplace/operator/refund-cases?state=paid", { headers }, env(h.db))).status).toBe(400);
    expect((await h.app.request("/internal/marketplace/operator/refund-cases?offset=10001", { headers }, env(h.db))).status).toBe(400);
    expect(h.queries).toHaveLength(0);
  });

  it("uses a lookahead row to report whether another page exists", async () => {
    const h = harness([
      { id: "case-a", tenant_id: "tenant-a", state: "review_required" },
      { id: "case-b", tenant_id: "tenant-a", state: "review_required" },
    ]);
    const response = await h.app.request("/internal/marketplace/operator/refund-cases?limit=1", {
      headers: { "x-managed-services-operator-key": operatorKey, "x-managed-services-operator-id": "ops-user-4" },
    }, env(h.db));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ limit: 1, has_more: true, cases: [{ id: "case-a" }] });
  });
});
