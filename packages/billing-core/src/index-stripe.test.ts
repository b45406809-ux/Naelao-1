import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureStripeCustomer, getSubscription } from "./index.js";

const config = { secretKey: "stripe-secret", baseUrl: "https://stripe.test/v1" };

function oversizedJsonResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"sub_123","customer":"cus_123","status":"active","items":{"data":[]}'));
      controller.enqueue(new Uint8Array(256 * 1024 + 1).fill(0x61));
      controller.enqueue(new TextEncoder().encode('}'));
      controller.close();
    },
  }));
}

describe("shared Stripe request boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("caps success responses and applies an outbound deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(oversizedJsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSubscription(config, "sub_123")).rejects.toThrow("response_too_large");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("escapes tenant search values and encodes Stripe query parameters", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json({ id: "cus_123" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(ensureStripeCustomer(config, 'tenant"\\x', "buyer@example.com")).resolves.toBe("cus_123");
    const searchUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(searchUrl.searchParams.get("query")).toBe('metadata["tenant_id"]:"tenant\\"\\\\x"');
    expect(searchUrl.searchParams.get("limit")).toBe("1");
  });

  it("rejects path separators in subscription IDs before making a provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSubscription(config, "sub_123/other")).rejects.toThrow("Invalid Stripe subscription ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
