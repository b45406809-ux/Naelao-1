import { describe, expect, it, vi } from "vitest";
import type { NormalizedBillingEvent } from "@naelao/billing-core";
import { recordPlatformPlanSubscription, recordProductUserPlanSubscription } from "./lemon-squeezy.js";

function event(overrides: Partial<NormalizedBillingEvent> = {}): NormalizedBillingEvent {
  return {
    type: "payment.failed", provider: "lemon_squeezy", spaceId: "", customerId: "customer-1",
    subscriptionId: "subscription-1", providerEventId: "payment-1", variantOrPriceId: "variant-1",
    amountCents: 2500, currency: "USD", metadata: { kind: "platform_plan", org_id: "org-1", plan: "growth" },
    providerUpdatedAt: "2026-11-12T14:00:00.000Z", ...overrides,
  };
}

function env() {
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const batch = vi.fn(async () => [{ meta: { changes: 1 } }, { meta: { changes: 1 } }]);
  const db = {
    prepare(query: string) {
      return { bind: (...values: unknown[]) => {
        statements.push({ query, values });
        return { query, values };
      } };
    },
    batch,
  } as unknown as D1Database;
  return { PLATFORM_DB: db, statements, batch };
}

describe("platform payment failure persistence", () => {
  it("atomically records the current subscription state and a stable dunning intent", async () => {
    const context = env();
    await expect(recordPlatformPlanSubscription(event(), context)).resolves.toBe(true);
    expect(context.batch).toHaveBeenCalledOnce();
    expect(context.statements).toHaveLength(2);
    expect(context.statements[0]?.query).toContain("UPDATE subscriptions SET status = 'past_due'");
    expect(context.statements[1]?.query).toContain("INSERT OR IGNORE INTO billing_dunning_outbox");
    expect(context.statements[1]?.query).toContain("AND status='past_due' AND billing_provider=? AND provider_event_at IS ?");
    expect(context.statements[1]?.values[0]).toMatch(/^dunning-[a-f0-9]{64}$/);
    expect(context.statements[1]?.values[1]).toBe("org-1");
    expect(context.statements[1]?.values[2]).toBe("lemon_squeezy");
    expect(context.statements[1]?.values[3]).toBe("subscription-1");
    expect(JSON.parse(String(context.statements[1]?.values[6]))).toMatchObject({
      type: "dunning", scope: "platform_subscription", orgId: "org-1", provider: "lemon_squeezy",
      subscriptionId: "subscription-1", providerEventId: "payment-1",
    });
  });

  it("uses the provider-specific subscription reference for Whop and stale guards", async () => {
    const context = env();
    await recordPlatformPlanSubscription(event({ provider: "whop" }), context);
    expect(context.statements[0]?.query).toContain("whop_subscription_id = ?");
    expect(context.statements[1]?.query).toContain("whop_subscription_id=?");
    expect(context.statements[1]?.values[2]).toBe("whop");
  });

  it("does not enqueue initial failures without a subscription identity", async () => {
    const context = env();
    await expect(recordPlatformPlanSubscription(event({ subscriptionId: null }), context)).resolves.toBe(true);
    expect(context.batch).not.toHaveBeenCalled();
  });

  it("records failed Product-user subscriptions in the same durable outbox", async () => {
    const context = env();
    const productFailure = event({
      spaceId: "product-1",
      metadata: { kind: "product_user_plan", product_id: "product-1", end_user_id: "end-user-1", plan: "growth" },
    });
    await expect(recordProductUserPlanSubscription(productFailure, { PLATFORM_DB: context.PLATFORM_DB, PLATFORM_SECRET: "test" })).resolves.toBe(true);
    expect(context.batch).toHaveBeenCalledOnce();
    expect(context.statements[0]?.query).toContain("UPDATE product_user_subscriptions SET status='past_due'");
    expect(context.statements[1]?.query).toContain("SELECT ?,p.tenant_id");
    expect(JSON.parse(String(context.statements[1]?.values[5]))).toMatchObject({
      type: "dunning", scope: "product_user_subscription", productId: "product-1", endUserId: "end-user-1",
      provider: "lemon_squeezy", subscriptionId: "subscription-1",
    });
  });
});
