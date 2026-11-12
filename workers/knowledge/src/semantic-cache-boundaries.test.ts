import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

function fixture(owned: boolean, options: { matches?: VectorizeMatch[]; cachedResponse?: string; pendingDeletion?: boolean; spaceSuspended?: boolean; airGapped?: boolean } = {}) {
  const query = vi.fn(async () => ({ matches: options.matches ?? [] }));
  const upsert = vi.fn(async () => ({ count: 1 }));
  const deleteByIds = vi.fn(async () => undefined);
  const kvDelete = vi.fn(async () => undefined);
  const kvPut = vi.fn(async (_key: string, _value: string) => undefined);
  const aiRun = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({ first: vi.fn(async () => {
      if (sql.includes("kb_document_deletion_operations")) return options.pendingDeletion ? { document_id: "doc-1" } : null;
      if (sql.includes("status = 'active'")) return owned && !options.spaceSuspended ? { id: "space-a" } : null;
      if (sql.includes("SELECT config_json FROM spaces")) return { config_json: options.airGapped ? '{"compliance":{"airGappedOnly":true}}' : "{}" };
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

  });

  it("bypasses semantic cache lookup and storage while any document deletion is pending", async () => {
    const lookup = fixture(true, { pendingDeletion: true, matches: [{ id: "cached", score: 0.999 }] });
    const lookupResponse = await worker.fetch(await signedRequest("/internal/semantic-cache/lookup", {
      query: "question", spaceId: "space-a",
    }), lookup.env, {} as ExecutionContext);
    expect(lookupResponse.status).toBe(200);
    await expect(lookupResponse.json()).resolves.toMatchObject({ hit: false, reason: "knowledge_deletion_pending" });
    expect(lookup.aiRun).not.toHaveBeenCalled();
    expect(lookup.query).not.toHaveBeenCalled();

    const store = fixture(true, { pendingDeletion: true });
    const storeResponse = await worker.fetch(await signedRequest("/internal/semantic-cache/store", {
      query: "question", response: "stale answer", spaceId: "space-a",
    }), store.env, {} as ExecutionContext);
    expect(storeResponse.status).toBe(200);
    await expect(storeResponse.json()).resolves.toMatchObject({ stored: false, reason: "knowledge_deletion_pending" });
    expect(store.aiRun).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
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

  it("requires an erasure request for the internal whole-Space cache cleanup route", async () => {
    const f = fixture(true);
    const response = await worker.fetch(await signedRequest("/internal/semantic-cache?spaceId=space-a", undefined, "DELETE"), f.env, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(f.aiRun).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });
});

function durableErasureFixture(options: {
  cachePages?: string[][];
  airGapped?: boolean;
  spaceExists?: boolean;
  requestStatus?: "processing" | "completed";
} = {}) {
  let requestStatus = options.requestStatus ?? "processing";
  let spaceExists = options.spaceExists ?? true;
  const cachePages = [...(options.cachePages ?? [])];
  const cacheDeletedIds: string[][] = [];
  const cacheKvDeleted: string[] = [];
  const generationPuts: Array<[string, string]> = [];
  let gdprCleanupStatus = "not_started";
  let activeOperation: Record<string, unknown> | null = null;

  class Statement {
    args: unknown[] = [];
    constructor(readonly sql: string) {}
    bind(...args: unknown[]) { this.args = args; return this; }
    async first<T>() {
      if (this.sql.includes("FROM gdpr_requests")) return { status: requestStatus } as T;
      if (this.sql.includes("FROM kb_document_deletion_operations")) {
        if (this.sql.includes("SELECT state,cache_cleanup_status")) {
          return activeOperation ? {
            state: activeOperation.state,
            cache_cleanup_status: activeOperation.cache_cleanup_status,
          } as T : null;
        }
        return activeOperation as T | null;
      }
      if (this.sql.includes("SELECT config_json FROM spaces")) {
        return spaceExists ? { config_json: options.airGapped ? '{"compliance":{"airGappedOnly":true}}' : "{}" } as T : null;
      }
      if (this.sql.includes("SELECT 1 FROM spaces")) return spaceExists ? { ok: 1 } as T : null;
      if (this.sql.includes("SELECT lease_until FROM kb_document_mutation_leases")) return null;
      if (this.sql.includes("SELECT state,attempts FROM kb_document_deletion_operations")) {
        return activeOperation ? { state: activeOperation.state, attempts: activeOperation.attempts } as T : null;
      }
      return null;
    }
    async all<T>() { return { results: [] as T[] }; }
    async run() {
      if (this.sql.startsWith("UPDATE kb_document_deletion_operations SET lease_token=?")) {
        if (!activeOperation || activeOperation.state !== "pending") return { meta: { changes: 0 } };
        activeOperation.lease_token = this.args[0];
        activeOperation.lease_until = this.args[1];
        activeOperation.attempts = Number(activeOperation.attempts) + 1;
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET cache_generation_to_purge=?")) {
        const operation = activeOperation;
        if (!operation || operation.lease_token !== this.args[4]) return { meta: { changes: 0 } };
        operation.cache_generation_to_purge = this.args[0];
        operation.cache_generation_next = this.args[1];
        operation.cache_cleanup_status = "pending";
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET cache_generation_rotated_at=?")) {
        const operation = activeOperation;
        if (!operation || operation.lease_token !== this.args[3]) return { meta: { changes: 0 } };
        operation.cache_generation_rotated_at = this.args[0];
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET cache_cleanup_status='complete'")) {
        const operation = activeOperation;
        if (!operation || operation.lease_token !== this.args[2]) return { meta: { changes: 0 } };
        operation.cache_cleanup_status = "complete";
        operation.cache_cleanup_ids_json = "[]";
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET cache_cleanup_ids_json=?")) {
        const operation = activeOperation;
        if (!operation || operation.lease_token !== this.args[3]) return { meta: { changes: 0 } };
        operation.cache_cleanup_ids_json = this.args[0];
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET cache_cleanup_ids_json='[]'")) {
        const operation = activeOperation;
        if (!operation || operation.lease_token !== this.args[2]) return { meta: { changes: 0 } };
        operation.cache_cleanup_ids_json = "[]";
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET lease_token=NULL")) {
        const operation = activeOperation;
        if (!operation || operation.lease_token !== this.args[4]) return { meta: { changes: 0 } };
        operation.lease_token = null;
        operation.lease_until = null;
        operation.last_error = this.args[1];
        operation.next_attempt_at = "2000-01-01T00:00:00.000Z";
      }
      return { meta: { changes: 1 } };
    }
  }

  const db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
      for (const statement of statements) {
        if (statement.sql.startsWith("INSERT OR IGNORE INTO kb_document_deletion_operations")) {
          const [id, tenantId, spaceId, nextAttempt, createdAt, updatedAt, erasureRequestId] = statement.args;
          activeOperation ??= {
            document_id: id, tenant_id: tenantId, space_id: spaceId, project_id: null, chunk_count: 0,
            state: "pending", vector_cursor: 0, r2_prefix_index: 0, r2_cursor: null,
            cache_generation_rotated_at: null, cache_generation_to_purge: "*", cache_generation_next: null,
            cache_cleanup_ids_json: "[]", cache_cleanup_status: "not_started", operation_kind: "space_cache",
            erasure_request_id: erasureRequestId, provider_mirror_status: "not_configured", attempts: 0,
            next_attempt_at: nextAttempt, lease_token: null, lease_until: null, last_error: null,
            created_at: createdAt, updated_at: updatedAt, completed_at: null,
          };
        }
        const operation = activeOperation;
        if (statement.sql.includes("SET state='complete'")) {
          if (operation && operation.lease_token === statement.args[3]) {
            operation.state = "complete";
            operation.lease_token = null;
            operation.lease_until = null;
            operation.completed_at = statement.args[1];
          }
        }
        if (statement.sql.includes("UPDATE gdpr_requests SET cache_cleanup_status=CASE")) {
          gdprCleanupStatus = operation?.state === "pending" ? "pending" : "complete";
        }
        if (statement.sql.includes("UPDATE gdpr_requests SET cache_cleanup_status='pending'")) gdprCleanupStatus = "pending";
      }
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  } as unknown as D1Database;

  const env = {
    ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: db,
    AI: { run: vi.fn() }, KB_BUCKET: { list: vi.fn(), delete: vi.fn(), head: vi.fn() },
    KB_VECTORS: { deleteByIds: vi.fn() },
    SEMANTIC_CACHE_VECTORS: {
      query: vi.fn(async () => ({ matches: (cachePages.shift() ?? []).map((id) => ({ id })) })),
      deleteByIds: vi.fn(async (ids: string[]) => cacheDeletedIds.push(ids)),
    },
    SEMANTIC_CACHE_KV: {
      get: vi.fn(async (key: string) => key.startsWith("sc-generation:") ? "generation-old" : null),
      put: vi.fn(async (key: string, value: string) => { generationPuts.push([key, value]); }),
      delete: vi.fn(async (key: string) => { cacheKvDeleted.push(key); }),
    },
  } as never;
  return {
    env, db, cacheDeletedIds, cacheKvDeleted, generationPuts,
    get operation() { return activeOperation; },
    get gdprCleanupStatus() { return gdprCleanupStatus; },
    setRequestStatus: (status: "processing" | "completed") => { requestStatus = status; },
    setSpaceExists: (value: boolean) => { spaceExists = value; },
  };
}

describe("durable whole-Space semantic cache erasure", () => {
  it("records scoped Vectorize IDs, deletes matching KV bodies, and completes through the scheduled ledger", async () => {
    const f = durableErasureFixture({ cachePages: [["cache-a"], []] });
    const url = "/internal/semantic-cache?spaceId=space-a&requestId=request-a";
    const first = await worker.fetch(await signedRequest(url, undefined, "DELETE"), f.env, {} as ExecutionContext);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ invalidated: true, cleanup_pending: true, cache_cleanup_status: "pending" });
    expect(f.cacheDeletedIds).toEqual([["cache-a"]]);
    expect(f.cacheKvDeleted).toEqual(["sc:cache-a"]);
    expect(f.generationPuts).toHaveLength(1);
    expect(f.operation).toMatchObject({ operation_kind: "space_cache", cache_generation_to_purge: "*", cache_cleanup_status: "pending" });

    const second = await worker.fetch(await signedRequest(url, undefined, "DELETE"), f.env, {} as ExecutionContext);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ invalidated: true, cleanup_pending: false, cache_cleanup_status: "complete" });
    expect(f.gdprCleanupStatus).toBe("complete");
  });

  it("rotates the read generation but defers Vectorize cleanup until Space egress is allowed", async () => {
    const f = durableErasureFixture({ airGapped: true, cachePages: [["cache-a"]] });
    const response = await worker.fetch(await signedRequest("/internal/semantic-cache?spaceId=space-a&requestId=request-a", undefined, "DELETE"), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ cleanup_pending: true, cache_cleanup_status: "pending" });
    expect(f.generationPuts).toHaveLength(1);
    expect(f.cacheDeletedIds).toHaveLength(0);
  });

  it("finishes an already authorized deletion-only receipt after Space rows are gone", async () => {
    const f = durableErasureFixture({ airGapped: true, cachePages: [["cache-a"]] });
    const url = "/internal/semantic-cache?spaceId=space-a&requestId=request-a";
    const first = await worker.fetch(await signedRequest(url, undefined, "DELETE"), f.env, {} as ExecutionContext);
    expect(first.status).toBe(200);
    f.setRequestStatus("completed");
    f.setSpaceExists(false);
    const retry = await worker.fetch(await signedRequest(url, undefined, "DELETE"), f.env, {} as ExecutionContext);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ cleanup_pending: true, cache_cleanup_status: "pending" });
    expect(f.cacheDeletedIds).toEqual([["cache-a"]]);
    expect(f.generationPuts).toHaveLength(1);
  });
});
