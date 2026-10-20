import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

function bindings(owned: boolean) {
  const run = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
  const query = vi.fn(async () => ({ matches: [] }));
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      first: vi.fn(async () => sql.includes("SELECT 1 FROM spaces")
        ? owned ? { owned: 1 } : null
        : { config_json: "{}" }),
    })),
  }));
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "secret",
    PLATFORM_DB: { prepare } as unknown as D1Database,
    AI: { run } as unknown as Ai,
    KB_VECTORS: { query } as unknown as VectorizeIndex,
    run,
    query,
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
});
