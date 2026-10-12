import { describe, expect, it } from "vitest";
import { LemonSqueezyProvider } from "./lemon-squeezy.js";

describe("Lemon Squeezy payment event identities", () => {
  const provider = new LemonSqueezyProvider({ LEMON_SQUEEZY_WEBHOOK_SECRET: "unused" });

  it("separates a subscription payment resource from its idempotency key", () => {
    const event = provider.parseWebhookEvent(JSON.stringify({
      meta: { event_name: "subscription_payment_success", custom_data: { spaceId: "space-1", kind: "template_subscription" } },
      data: { id: "subscription-resource", attributes: { subscription_id: "sub-1", order_id: "order-42", total: 2000, currency: "USD", custom_data: { spaceId: "space-1", template_subscription_id: "template-sub-1" } } },
    }));
    expect(event).toMatchObject({ type: "payment.success", spaceId: "space-1", subscriptionId: "sub-1", providerEventId: "order-42", amountCents: 2000 });
  });

  it("does not mistake a long-lived subscription id for a payment id", () => {
    const event = provider.parseWebhookEvent(JSON.stringify({
      meta: { event_name: "subscription_payment_success" },
      data: { id: "subscription-resource", attributes: { total: 2000 } },
    }));
    expect(event.subscriptionId).toBe("subscription-resource");
    expect(event.providerEventId).toBeNull();
  });

  it("uses a provider resource update timestamp when no payment id is supplied", () => {
    const event = provider.parseWebhookEvent(JSON.stringify({
      meta: { event_name: "subscription_payment_recovered" },
      data: { id: "subscription-resource", attributes: { total: 2000, updated_at: "2026-10-12T12:00:00Z" } },
    }));
    expect(event.providerEventId).toBe("subscription-resource:subscription_payment_recovered:2026-10-12T12:00:00Z");
  });
});
