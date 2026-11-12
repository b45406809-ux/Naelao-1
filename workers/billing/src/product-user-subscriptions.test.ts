import { describe, expect, it } from "vitest";
import type { NormalizedBillingEvent } from "@naelao/billing-core";
import { recordProductUserPlanSubscription } from "./lemon-squeezy.js";

function event(overrides: Partial<NormalizedBillingEvent> = {}): NormalizedBillingEvent {
  return {
    type: "subscription.created", provider: "lemon_squeezy", spaceId: "product-1", customerId: "customer-1",
    subscriptionId: "subscription-1", providerEventId: "event-1", variantOrPriceId: "variant-1", amountCents: 1000,
    currency: "USD", metadata: { kind: "product_user_plan", product_id: "product-1", end_user_id: "user-1", plan: "growth" },
    providerStatus: "active", providerUpdatedAt: "2026-11-05T00:00:00Z", ...overrides,
  };
}

describe("Product user subscription entitlements", () => {
  it("writes customer plans by Product account and never mutates the shared org plan", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) { return { bind(...args: unknown[]) {
        statements.push({ sql, args });
        return { first: async () => ({ active: 1 }), run: async () => ({ meta: { changes: 1 } }) };
      } }; },
    } as unknown as D1Database;
    expect(await recordProductUserPlanSubscription(event(), { PLATFORM_DB: db, PLATFORM_SECRET: "secret" })).toBe(true);
    const write = statements.at(-1)!;
    expect(write.sql).toContain("INSERT INTO product_user_subscriptions");
    expect(write.sql).not.toContain("orgs");
    expect(write.args.slice(0, 5)).toEqual(["product-1", "user-1", "growth", "active", "lemon_squeezy"]);
  });

  it("drops the paid entitlement on expiration and ignores stale lifecycle events", async () => {
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    const db = { prepare(sql: string) { return { bind(...args: unknown[]) {
      writes.push({ sql, args }); return { first: async () => ({ active: 1 }), run: async () => ({ meta: { changes: 0 } }) };
    } }; } } as unknown as D1Database;
    await recordProductUserPlanSubscription(event({ type: "subscription.expired", providerStatus: "expired" }), { PLATFORM_DB: db, PLATFORM_SECRET: "secret" });
    expect(writes.at(-1)?.args.slice(0, 4)).toEqual(["product-1", "user-1", "free", "expired"]);
    await recordProductUserPlanSubscription(event({ providerUpdatedAt: "2026-11-04T00:00:00Z" }), { PLATFORM_DB: db, PLATFORM_SECRET: "secret" });
    expect(writes.at(-1)?.sql).toContain("provider_event_at");
    expect(writes.at(-1)?.sql).toContain("excluded.provider_event_at IS NULL AND product_user_subscriptions.provider_event_at IS NULL");
  });
});
