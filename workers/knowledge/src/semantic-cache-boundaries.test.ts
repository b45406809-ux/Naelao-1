import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

function fixture(owned: boolean, options: { matches?: VectorizeMatch[]; cachedResponse?: string } = {}) {
  const query = vi.fn(async () => ({ matches: options.matches ?? [] }));
  const upsert = vi.fn(async () => ({ count: 1 }));
  const deleteByIds = vi.fn(async () => undefined);
  const kvDelete = vi.fn(async () => undefined);
  const kvPut = vi.fn(async (_key: string, _value: string) => undefined);
  const aiRun = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({ first: vi.fn(async () => {
      if (sql.includes("tenant_id = ?")) return owned ? { owned: 1 } : null;
      return { config_json: "{}" };
    }) })),
  }));
  return {
    env: {
      ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: { prepare },
      AI: { run: aiRun },
      SEMANTIC_CACHE_VECTORS: { query, upsert, deleteByIds },
      SEMANTIC_CACHE_KV: {
        get: vi.fn(async (key: string) => key.startsWith("sc-generation:") ? null : options.cachedResponse ?? null),
        put: kvPut, delete: kvDelete,
      },
    } as never,
    query, upsert, deleteByIds, kvDelete, kvPut, aiRun,
  };
}

async function signedRequest(path: string, body?: unknown, method = "POST"): Promise<Request> {
  const token = await mintInternalToken("secret", "tenant-a");
  return new Request(`https://knowledge${path}`, {
    method,
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("semantic response cache tenant and request bounds", () => {
  it("refuses foreign-space lookup and storage before AI or Vectorize", async () => {
    const lookup = fixture(false);
    const lookupResponse = await worker.fetch(await signedRequest("/internal/semantic-cache/lookup", { query: "question", spaceId: "space-b" }), lookup.env, {} as ExecutionContext);
    expect(lookupResponse.status).toBe(404);
    expect(lookup.aiRun).not.toHaveBeenCalled();
    expect(lookup.query).not.toHaveBeenCalled();

    const store = fixture(false);
    const storeResponse = await worker.fetch(await signedRequest("/internal/semantic-cache/store", { query: "question", spaceId: "space-b", response: "answer" }), store.env, {} as ExecutionContext);
    expect(storeResponse.status).toBe(404);
    expect(store.aiRun).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();

    const invalidation = fixture(false);
    const deleteResponse = await worker.fetch(await signedRequest("/internal/semantic-cache?spaceId=space-b", undefined, "DELETE"), invalidation.env, {} as ExecutionContext);
    expect(deleteResponse.status).toBe(404);
    expect(invalidation.aiRun).not.toHaveBeenCalled();
    expect(invalidation.query).not.toHaveBeenCalled();
  });

  it("bounds query and response fields and scopes vector reads and writes by tenant", async () => {
    const invalid = fixture(true);
    const badQuery = await worker.fetch(await signedRequest("/internal/semantic-cache/lookup", { query: "q".repeat(1_001), spaceId: "space-a" }), invalid.env, {} as ExecutionContext);
    expect(badQuery.status).toBe(400);
    expect(invalid.aiRun).not.toHaveBeenCalled();

    const stored = fixture(true);
    const storeResponse = await worker.fetch(await signedRequest("/internal/semantic-cache/store", { query: "question", spaceId: "space-a", response: "answer" }), stored.env, {} as ExecutionContext);
    expect(storeResponse.status).toBe(200);
    expect(stored.upsert).toHaveBeenCalledWith([expect.objectContaining({
      metadata: expect.objectContaining({ tenant_id: "tenant-a", space_id: "space-a" }),
    })]);

    const lookedUp = fixture(true);
    const lookupResponse = await worker.fetch(await signedRequest("/internal/semantic-cache/lookup", { query: "question", spaceId: "space-a" }), lookedUp.env, {} as ExecutionContext);
    expect(lookupResponse.status).toBe(200);
    expect(lookedUp.query).toHaveBeenCalledWith([0.1, 0.2], expect.objectContaining({
      filter: { tenant_id: { $eq: "tenant-a" }, space_id: { $eq: "space-a" }, generation: { $eq: "0" } },
    }));

    const invalidated = fixture(true);
    const deleteResponse = await worker.fetch(await signedRequest("/internal/semantic-cache?spaceId=space-a", undefined, "DELETE"), invalidated.env, {} as ExecutionContext);
    expect(deleteResponse.status).toBe(200);
    expect(invalidated.query).toHaveBeenCalledWith([0.1, 0.2], expect.objectContaining({
      filter: { tenant_id: { $eq: "tenant-a" }, space_id: { $eq: "space-a" }, generation: { $eq: "0" } },
    }));
    expect(invalidated.kvPut.mock.calls[0]?.[0]).toMatch(/^sc-generation:/);
  });

  it("ignores vectors without a valid TTL and refuses oversized cached responses", async () => {
    const invalidExpiry = fixture(true, { matches: [{ id: "stale", score: 0.99, metadata: {} }] });
    const waitUntil = vi.fn();
    const staleResponse = await worker.fetch(await signedRequest("/internal/semantic-cache/lookup", { query: "question", spaceId: "space-a" }), invalidExpiry.env, { waitUntil } as never);
    expect(staleResponse.status).toBe(200);
    await expect(staleResponse.json()).resolves.toMatchObject({ hit: false });
    expect(invalidExpiry.deleteByIds).toHaveBeenCalledWith(["stale"]);
    expect(waitUntil).toHaveBeenCalledOnce();

    const tooLarge = fixture(true, {
      matches: [{ id: "large", score: 0.99, metadata: { expires_at: Date.now() + 60_000 } }],
      cachedResponse: "x".repeat(1_048_577),
    });
    const largeWaitUntil = vi.fn();
    const largeResponse = await worker.fetch(await signedRequest("/internal/semantic-cache/lookup", { query: "question", spaceId: "space-a" }), tooLarge.env, { waitUntil: largeWaitUntil } as never);
    expect(largeResponse.status).toBe(200);
    await expect(largeResponse.json()).resolves.toMatchObject({ hit: false });
    expect(tooLarge.kvDelete).toHaveBeenCalledWith("sc:large");
    expect(largeWaitUntil).toHaveBeenCalledOnce();
  });

  it("rotates the generation and reports pending cleanup at the 1,000-vector ceiling", async () => {
    const matches = Array.from({ length: 1_000 }, (_, index) => ({ id: `cache-${index}`, score: 0.5 }));
    const f = fixture(true, { matches });
    const response = await worker.fetch(await signedRequest("/internal/semantic-cache?spaceId=space-a", undefined, "DELETE"), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ invalidated: true, count: 1_000, cleanup_pending: true });
    expect(f.deleteByIds).toHaveBeenCalledOnce();
    expect(f.kvPut.mock.calls[0]?.[0]).toMatch(/^sc-generation:/);
  });
});
