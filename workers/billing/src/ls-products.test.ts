import { afterEach, describe, expect, it, vi } from "vitest";
import { createLsProductVariant } from "./ls-products.js";

const product = { name: "Audit Toolkit", price_cents: 1200, kind: "one_time" as const };

function oversizedResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"data":{"id":"1","type":"products","attributes":{"name":"'));
      controller.enqueue(new Uint8Array(64 * 1024 + 1).fill(0x61));
      controller.enqueue(new TextEncoder().encode('"}}}'));
      controller.close();
    },
  }));
}

describe("Lemon Squeezy product provisioning response boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a product and variant using bounded, typed provider responses and request deadlines", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { id: "100", type: "products" } }))
      .mockResolvedValueOnce(Response.json({ data: { id: "200", type: "variants" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createLsProductVariant({ apiKey: "key", storeId: "store" }, product)).resolves.toEqual({ lsProductId: "100", lsVariantId: "200" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("does not attempt variant creation after an oversized product response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(oversizedResponse());
    vi.stubGlobal("fetch", fetchMock);
    await expect(createLsProductVariant({ apiKey: "key", storeId: "store" }, product)).rejects.toThrow("invalid or oversized response");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched JSON:API resource type before using its ID", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: { id: "100", type: "variants" } })));
    await expect(createLsProductVariant({ apiKey: "key", storeId: "store" }, product)).rejects.toThrow("invalid resource");
  });
});
