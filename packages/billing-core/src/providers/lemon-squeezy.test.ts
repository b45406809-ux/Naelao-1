import { afterEach, describe, expect, it, vi } from "vitest";
import { LemonSqueezyProvider, lsListStores } from "./lemon-squeezy.js";

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

  it("normalizes a signed subscription update timestamp and ignores invalid versions", () => {
    const valid = provider.parseWebhookEvent(JSON.stringify({
      meta: { event_name: "subscription_updated" },
      data: { id: "sub-1", attributes: { status: "active", updated_at: "2026-10-12T12:00:00+00:00" } },
    }));
    expect(valid.providerUpdatedAt).toBe("2026-10-12T12:00:00.000Z");
    const invalid = provider.parseWebhookEvent(JSON.stringify({
      meta: { event_name: "subscription_updated" },
      data: { id: "sub-1", attributes: { status: "active", updated_at: "10/12/2026" } },
    }));
    expect(invalid.providerUpdatedAt).toBeUndefined();
  });

  it("keeps explicit partial-refund amount separate from the original order total", () => {
    const event = provider.parseWebhookEvent(JSON.stringify({
      meta: { event_name: "order_refunded", custom_data: { kind: "personal_plan" } },
      data: { id: "order-42", attributes: { total: 5000, refunded_amount: 1200, currency: "USD", custom_data: { kind: "personal_plan" } } },
    }));
    expect(event).toMatchObject({ type: "refund.issued", providerEventId: "order-42", amountCents: 5000, refundAmountCents: 1200 });
  });
});

describe("Lemon Squeezy provider response boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("bounds checkout response parsing and applies a provider deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":{"attributes":{"url":"https://store.lemonsqueezy.com/checkout/buy/'));
        controller.enqueue(new Uint8Array(256 * 1024 + 1).fill(0x61));
        controller.enqueue(new TextEncoder().encode('"}}}'));
        controller.close();
      },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const configured = new LemonSqueezyProvider({ LEMON_SQUEEZY_API_KEY: "key", LEMON_SQUEEZY_STORE_ID: "store" });
    await expect(configured.createCheckout({ spaceId: "space", variantOrPriceId: "variant" })).rejects.toThrow("invalid or oversized response");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects path separators in subscription IDs before network dispatch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const configured = new LemonSqueezyProvider({ LEMON_SQUEEZY_API_KEY: "key" });
    await expect(configured.getCustomerPortalUrl("sub_1/other")).rejects.toThrow("Invalid Lemon Squeezy subscription ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds store listing responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":['));
        controller.enqueue(new Uint8Array(256 * 1024 + 1).fill(0x61));
        controller.enqueue(new TextEncoder().encode(']}'));
        controller.close();
      },
    })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(lsListStores("key")).rejects.toThrow("invalid or oversized response");
  });
});
