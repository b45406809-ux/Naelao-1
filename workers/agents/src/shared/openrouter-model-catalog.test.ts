import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOpenRouterCatalog, isOpenRouterPlannerCandidate, openRouterCatalogForTest } from "./openrouter-model-catalog.js";

describe("OpenRouter model catalog", () => {
  beforeEach(() => { vi.restoreAllMocks(); openRouterCatalogForTest.reset(); });

  it("validates the key and parses only bounded catalog metadata", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/key")) {
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer user-key");
        return Response.json({ data: { label: "test" } });
      }
      expect(url).toBe("https://openrouter.ai/api/v1/models");
      return Response.json({ data: [
        { id: "vendor/model-a", name: "Model A", context_length: 32768, pricing: { prompt: "0.000001", completion: "0.000002" }, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["tools", "temperature"] },
        { id: "vendor/model-a", name: "Duplicate" },
        { id: "bad id", name: "Invalid id" },
      ] });
    });
    const models = await fetchOpenRouterCatalog("user-key", { fetch: fetcher as typeof fetch, now: 1 });
    expect(models).toEqual([{
      id: "vendor/model-a", model: "openrouter/vendor/model-a", name: "Model A", contextLength: 32768,
      promptPriceUsdPerToken: 0.000001, completionPriceUsdPerToken: 0.000002,
      inputModalities: ["text", "image"], outputModalities: ["text"],
      supportedParameters: ["tools", "temperature"],
    }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid key and malformed or oversized catalogs", async () => {
    const unauthorized = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(fetchOpenRouterCatalog("bad-key", { fetch: unauthorized as typeof fetch, now: 1 })).rejects.toThrow("openrouter_key_rejected");
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(openRouterCatalogForTest.parse({ data: [{ id: "x".repeat(257) }] })).toEqual([]);
    expect(() => openRouterCatalogForTest.parse({ models: [] })).toThrow("openrouter_catalog_shape_invalid");
  });

  it("caches catalog data but revalidates each user's key", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/auth/key")
      ? Response.json({ data: {} })
      : Response.json({ data: [{ id: "vendor/model-b" }] }));
    await fetchOpenRouterCatalog("first", { fetch: fetcher as typeof fetch, now: 10, cacheMs: 1000 });
    await fetchOpenRouterCatalog("second", { fetch: fetcher as typeof fetch, now: 20, cacheMs: 1000 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("only dynamically enables candidates whose live catalog metadata declares text and tools", () => {
    expect(isOpenRouterPlannerCandidate({ id: "a", model: "openrouter/a", name: "A", contextLength: 262_144, inputModalities: ["text"], outputModalities: ["text"], supportedParameters: ["tools"] })).toBe(true);
    expect(isOpenRouterPlannerCandidate({ id: "b", model: "openrouter/b", name: "B", contextLength: 262_144, inputModalities: ["text"], outputModalities: ["text"] })).toBe(false);
    expect(isOpenRouterPlannerCandidate({ id: "c", model: "openrouter/c", name: "C", contextLength: 262_144, inputModalities: ["image"], outputModalities: ["text"], supportedParameters: ["tools"] })).toBe(false);
    expect(isOpenRouterPlannerCandidate({ id: "d", model: "openrouter/d", name: "D", contextLength: 128_000, inputModalities: ["text"], outputModalities: ["text"], supportedParameters: ["tools"] })).toBe(false);
  });
});
