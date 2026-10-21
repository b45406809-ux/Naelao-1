import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubMerchant, createSubMerchantCheckout } from "./whop.js";
import { createWhopPlatformPlanCheckout } from "./whop-platform-plan.js";

function oversizedJsonResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"company_1","extra":"'));
      controller.enqueue(new Uint8Array(128 * 1024 + 1).fill(0x61));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  }));
}

describe("Whop money-in and payout provider boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("caps platform sub-merchant responses and applies a request deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "company_1", status: "active" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createSubMerchant("key", { tenantId: "tenant", businessId: "business", ownerEmail: "owner@example.com", businessName: "Store" })).resolves.toMatchObject({ company_id: "company_1" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("stops after an oversized sub-merchant response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(oversizedJsonResponse()));
    await expect(createSubMerchant("key", { tenantId: "tenant", businessId: "business", ownerEmail: "owner@example.com", businessName: "Store" })).rejects.toThrow("invalid or oversized response");
  });

  it("rejects insecure checkout URLs from both Whop checkout providers", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ checkout_url: "javascript:alert(1)" }))
      .mockResolvedValueOnce(Response.json({ checkout_url: "http://whop.com/checkout" })));
    await expect(createSubMerchantCheckout("key", { companyId: "company_1", productName: "Plan", amountCents: 100 })).rejects.toThrow("valid HTTPS url");
    await expect(createWhopPlatformPlanCheckout("key", { planId: "plan_1", metadata: {} })).rejects.toThrow("valid HTTPS checkout url");
  });
});
