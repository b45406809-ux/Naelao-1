import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

function bindings(owned: boolean, pendingDeletion = false) {
  const run = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
  const query = vi.fn(async () => ({ matches: [] }));
  const cacheQuery = vi.fn(async () => ({ matches: [{ id: "cached-answer", score: 0.999 }] }));
  const groundedCacheGet = vi.fn(async () => ({ createdAt: Date.now(), expiresAt: Date.now() + 60_000, hits: [{ id: "doc-1_chunk_0", content: "deleted content" }] }));
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      first: vi.fn(async () => sql.includes("SELECT 1 FROM spaces")
        ? owned ? { owned: 1 } : null
        : sql.includes("kb_document_deletion_operations")
          ? pendingDeletion ? { document_id: "doc-1" } : null
          : { config_json: "{}" }),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    })),
  }));
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "secret",
    PLATFORM_DB: { prepare, batch: vi.fn(async () => []) } as unknown as D1Database,
    AI: { run } as unknown as Ai,
    KB_VECTORS: { query } as unknown as VectorizeIndex,
    SEMANTIC_CACHE_VECTORS: { query: cacheQuery } as unknown as VectorizeIndex,
    SEMANTIC_CACHE_KV: { get: vi.fn(async (key: string) => key.startsWith("sc-generation:") ? "cache-generation-1" : "cached") } as unknown as KVNamespace,
    KB_CACHE: { get: groundedCacheGet, put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) } as unknown as KVNamespace,
    run,
    query,
    cacheQuery,
    groundedCacheGet,
  };
}

async function searchRequest(query: string) {
  const token = await mintInternalToken("secret", "tenant-a");
  return new Request(`https://knowledge/spaces/space-b/kb/search?q=${encodeURIComponent(query)}`, {
    headers: {
      "x-naelao-tenant-id": "tenant-a",
      "x-naelao-internal-token": token,
      "x-naelao-user-id": "user-a",
      "x-naelao-role": "owner",
    },
  });
}

describe("knowledge search tenant and query bounds", () => {
  it("refuses a foreign tenant's space before embeddings or vector search", async () => {
    const env = bindings(false);
    const response = await worker.fetch!(await searchRequest("policy"), env as never, {} as ExecutionContext);
    expect(response.status).toBe(404);
    expect(env.run).not.toHaveBeenCalled();
    expect(env.query).not.toHaveBeenCalled();
  });

  it("rejects overlong semantic queries before Workers AI or Vectorize", async () => {
    const env = bindings(true);
    const response = await worker.fetch!(await searchRequest("x".repeat(1_001)), env as never, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(env.run).not.toHaveBeenCalled();
    expect(env.query).not.toHaveBeenCalled();
  });

  it("bypasses semantic and grounded cached answers while document deletion is pending", async () => {
    const env = bindings(true, true);
    const response = await worker.fetch!(await searchRequest("policy"), env as never, {} as ExecutionContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [], cached: false });
    expect(env.cacheQuery).not.toHaveBeenCalled();
    expect(env.groundedCacheGet).not.toHaveBeenCalled();
  });
});
