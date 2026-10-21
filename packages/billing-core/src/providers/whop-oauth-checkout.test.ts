import { afterEach, describe, expect, it, vi } from "vitest";
import { createWhopOAuthCheckout } from "./whop-oauth-checkout.js";

const params = { title: "Workspace plan", priceCents: 1200, billingModel: "renewal" as const, billingPeriodDays: 30 };

function oversizedResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"pass_1","extra":"'));
      controller.enqueue(new Uint8Array(128 * 1024 + 1).fill(0x61));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  }));
}

describe("Whop OAuth checkout provider boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("bounds the three-step checkout flow and applies deadlines to every request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "pass_1" }))
      .mockResolvedValueOnce(Response.json({ id: "plan_1" }))
      .mockResolvedValueOnce(Response.json({ checkout_url: "https://whop.com/checkout/abc" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createWhopOAuthCheckout("access-token", params)).resolves.toEqual({ checkout_url: "https://whop.com/checkout/abc" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("halts the flow on an oversized access-pass response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(oversizedResponse());
    vi.stubGlobal("fetch", fetchMock);
    await expect(createWhopOAuthCheckout("access-token", params)).rejects.toThrow("invalid or oversized response");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects an insecure checkout URL", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "pass_1" }))
      .mockResolvedValueOnce(Response.json({ id: "plan_1" }))
      .mockResolvedValueOnce(Response.json({ checkout_url: "javascript:alert(1)" })));
    await expect(createWhopOAuthCheckout("access-token", params)).rejects.toThrow("valid HTTPS checkout url");
  });
});
