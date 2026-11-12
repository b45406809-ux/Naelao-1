import { describe, expect, it, vi } from "vitest";
import {
  type KnowledgeDocumentDeletion,
  processKnowledgeDocumentDeletion,
  reconcileKnowledgeDocumentDeletions,
} from "./document-deletion.js";

function fixture(
  options: {
    mutationLease?: string | null;
    failFirstObjectDelete?: boolean;
    semanticCachePages?: string[][];
  } = {}
) {
  const now = new Date().toISOString();
  const operation: KnowledgeDocumentDeletion = {
    document_id: "doc-1",
    tenant_id: "tenant-1",
    space_id: "space-1",
    project_id: "project-1",
    chunk_count: 250,
    state: "pending",
    vector_cursor: 0,
    r2_prefix_index: 0,
    r2_cursor: null,
    cache_generation_rotated_at: null,
    cache_generation_to_purge: null,
    cache_generation_next: null,
    cache_cleanup_ids_json: "[]",
    cache_cleanup_status: "not_started",
    operation_kind: "document",
    erasure_request_id: null,
    provider_mirror_status: "not_configured",
    attempts: 0,
    next_attempt_at: "2000-01-01T00:00:00.000Z",
    lease_token: null,
    lease_until: null,
    last_error: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
  let documentExists = true;
  let mutationLeaseUntil = options.mutationLease ?? null;
  let failFirstDelete = options.failFirstObjectDelete ?? false;
  const deletedVectorIds: string[][] = [];
  const deletedR2Keys: string[] = [];
  const kvPuts: Array<[string, string]> = [];
  const kvDeletes: string[] = [];
  const semanticCacheDeletedIds: string[][] = [];
  const semanticCachePages = [...(options.semanticCachePages ?? [])];
  const persistedIdsAtCacheDelete: string[] = [];

  class Statement {
    args: unknown[] = [];
    constructor(readonly sql: string) {}
    bind(...args: unknown[]) {
      this.args = args;
      return this;
    }
    async first<T>() {
      if (this.sql.includes("FROM kb_document_mutation_leases")) {
        return (
          mutationLeaseUntil ? { lease_until: mutationLeaseUntil } : null
        ) as T | null;
      }
      if (this.sql.includes("FROM kb_document_deletion_operations")) {
        return operation as T;
      }
      if (this.sql.includes("FROM gdpr_requests")) return null;
      return null;
    }
    async all<T>() {
      if (this.sql.includes("FROM kb_document_deletion_operations")) {
        const due =
          operation.state === "pending" &&
          operation.next_attempt_at <= String(this.args[0]) &&
          (!operation.lease_until ||
            operation.lease_until <= String(this.args[1]));
        return {
          results: (due ? [{ document_id: operation.document_id }] : []) as T[],
        };
      }
      return { results: [] as T[] };
    }
    async run() {
      if (this.sql.includes("SET state='pending',next_attempt_at=?") && this.sql.includes("cache_cleanup_status='pending'")) {
        if (operation.state === "complete" && operation.cache_cleanup_status === "pending") {
          operation.state = "pending";
          operation.next_attempt_at = String(this.args[0]);
          operation.lease_token = null;
          operation.lease_until = null;
          operation.updated_at = String(this.args[1]);
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
      if (
        this.sql.startsWith(
          "UPDATE kb_document_deletion_operations SET lease_token=?"
        )
      ) {
        if (
          operation.state !== "pending" ||
          operation.next_attempt_at > String(this.args[4]) ||
          (operation.lease_until &&
            operation.lease_until > String(this.args[5]))
        )
          return { meta: { changes: 0 } };
        operation.lease_token = String(this.args[0]);
        operation.lease_until = String(this.args[1]);
        operation.attempts += 1;
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET cache_generation_rotated_at=?")) {
        if (operation.lease_token !== this.args[3])
          return { meta: { changes: 0 } };
        operation.cache_generation_rotated_at = String(this.args[0]);
        operation.updated_at = String(this.args[1]);
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET cache_generation_to_purge=?")) {
        if (operation.lease_token !== this.args[4]) return { meta: { changes: 0 } };
        operation.cache_generation_to_purge = String(this.args[0]);
        operation.cache_generation_next = String(this.args[1]);
        operation.cache_cleanup_status = "pending";
        operation.updated_at = String(this.args[2]);
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET cache_cleanup_status='complete'")) {
        if (operation.lease_token !== this.args[2]) return { meta: { changes: 0 } };
        operation.cache_cleanup_status = "complete";
        operation.cache_cleanup_ids_json = "[]";
        operation.updated_at = String(this.args[0]);
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET cache_cleanup_ids_json=?")) {
        if (operation.lease_token !== this.args[3]) return { meta: { changes: 0 } };
        operation.cache_cleanup_ids_json = String(this.args[0]);
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET cache_cleanup_ids_json='[]'")) {
        if (operation.lease_token !== this.args[2]) return { meta: { changes: 0 } };
        operation.cache_cleanup_ids_json = "[]";
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET vector_cursor=?")) {
        if (
          operation.lease_token !== this.args[3] ||
          operation.vector_cursor !== this.args[4]
        )
          return { meta: { changes: 0 } };
        operation.vector_cursor = Number(this.args[0]);
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET r2_prefix_index=?")) {
        if (operation.lease_token !== this.args[4])
          return { meta: { changes: 0 } };
        operation.r2_prefix_index = Number(this.args[0]);
        operation.r2_cursor = this.args[1] as string | null;
        return { meta: { changes: 1 } };
      }
      if (this.sql.includes("SET lease_token=NULL")) {
        if (operation.lease_token !== this.args[4])
          return { meta: { changes: 0 } };
        operation.lease_token = null;
        operation.lease_until = null;
        operation.next_attempt_at = "2000-01-01T00:00:00.000Z";
        operation.last_error = this.args[1] as string | null;
        operation.updated_at = String(this.args[2]);
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 1 } };
    }
  }

  const db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
      for (const statement of statements) {
        if (statement.sql.startsWith("DELETE FROM kb_chunks")) continue;
        if (statement.sql.startsWith("DELETE FROM kb_documents")) {
          if (operation.lease_token === statement.args[4])
            documentExists = false;
          continue;
        }
        if (statement.sql.includes("SET state='complete'")) {
          if (statement.sql.includes("cache_cleanup_status='complete'")) {
            if (operation.lease_token === statement.args[3]) {
              operation.state = "complete";
              operation.lease_token = null;
              operation.lease_until = null;
              operation.completed_at = String(statement.args[1]);
            }
            continue;
          }
          if (operation.lease_token === statement.args[4] && !documentExists) {
            operation.state = "complete";
            operation.provider_mirror_status = String(statement.args[0]);
            operation.lease_token = null;
            operation.lease_until = null;
            operation.completed_at = String(statement.args[2]);
            operation.last_error = null;
          }
        }
      }
      return [];
    },
  } as unknown as D1Database;

  const bucket = {
    list: vi.fn(
      async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
        if (prefix.startsWith("kb/")) {
          return cursor
            ? { objects: [{ key: `${prefix}chunk_1.txt` }], truncated: false }
            : {
                objects: [{ key: `${prefix}chunk_0.txt` }],
                truncated: true,
                cursor: "page-2",
              };
        }
        return { objects: [{ key: `${prefix}original` }], truncated: false };
      }
    ),
    delete: vi.fn(async (keys: string | string[]) => {
      if (failFirstDelete) {
        failFirstDelete = false;
        throw new Error("temporary R2 outage");
      }
      deletedR2Keys.push(...(Array.isArray(keys) ? keys : [keys]));
    }),
    head: vi.fn(async () => null),
  };
  const env = {
    PLATFORM_DB: db,
    KB_BUCKET: bucket,
    KB_VECTORS: {
      deleteByIds: vi.fn(async (ids: string[]) => {
        deletedVectorIds.push(ids);
      }),
    },
    SEMANTIC_CACHE_KV: {
      get: vi.fn(async () => "generation-1"),
      put: vi.fn(async (key: string, value: string) => {
        kvPuts.push([key, value]);
      }),
      delete: vi.fn(async (key: string) => { kvDeletes.push(key); }),
    },
    SEMANTIC_CACHE_VECTORS: {
      query: vi.fn(async () => ({ matches: (semanticCachePages.shift() ?? []).map((id) => ({ id })) })),
      deleteByIds: vi.fn(async (ids: string[]) => {
        persistedIdsAtCacheDelete.push(operation.cache_cleanup_ids_json);
        semanticCacheDeletedIds.push(ids);
      }),
    },
    AUTORAG_KB_INSTANCE: "knowledge-test",
  } as unknown as Parameters<typeof processKnowledgeDocumentDeletion>[0];

  return {
    env,
    operation,
    bucket,
    deletedVectorIds,
    deletedR2Keys,
    kvPuts,
    kvDeletes,
    semanticCacheDeletedIds,
    persistedIdsAtCacheDelete,
    isDocumentPresent: () => documentExists,
    setMutationLease: (value: string | null) => {
      mutationLeaseUntil = value;
    },
  };
}

describe("durable Knowledge document deletion", () => {
  it("tombstones cache and resumes bounded Vectorize/R2 cleanup before removing D1 state", async () => {
    const f = fixture();
    const result = await processKnowledgeDocumentDeletion(f.env, "doc-1");

    expect(result.state).toBe("complete");
    expect(f.deletedVectorIds.map((ids) => ids.length)).toEqual([100, 100, 50]);
    expect(f.deletedVectorIds.flat()[0]).toBe("doc-1_chunk_0");
    expect(f.deletedVectorIds.flat().at(-1)).toBe("doc-1_chunk_249");
    expect(f.bucket.list).toHaveBeenCalledTimes(3); // two KB pages and one staging page
    expect(f.deletedR2Keys).toEqual([
      "kb/space-1/project-1/doc-1/chunk_0.txt",
      "kb/space-1/project-1/doc-1/chunk_1.txt",
      "staging/tenant-1/space-1/project-1/doc-1/original",
      "autorag/space-1/project-1/doc-1.md",
    ]);
    expect(f.bucket.delete).toHaveBeenCalledWith(
      "autorag/space-1/project-1/doc-1.md"
    );
    expect(f.bucket.head).toHaveBeenCalledWith(
      "autorag/space-1/project-1/doc-1.md"
    );
    expect(f.kvPuts).toHaveLength(1);
    expect(f.operation.state).toBe("complete");
    expect(f.operation.provider_mirror_status).toBe(
      "r2_source_deleted_provider_index_unverified"
    );
    expect(f.isDocumentPresent()).toBe(false);
  });

  it("keeps the document tombstoned and retries an external failure without rotating cache twice", async () => {
    const f = fixture({ failFirstObjectDelete: true });
    const first = await processKnowledgeDocumentDeletion(f.env, "doc-1");
    expect(first.state).toBe("pending");
    expect(f.operation.state).toBe("pending");
    expect(f.operation.last_error).toBe("resource_cleanup_retry_required");
    expect(f.isDocumentPresent()).toBe(true);

    const second = await processKnowledgeDocumentDeletion(f.env, "doc-1");
    expect(second.state).toBe("complete");
    expect(f.kvPuts).toHaveLength(1);
    expect(f.deletedVectorIds).toHaveLength(3); // completed vector cursor is durable across retry
  });

  it("waits for a live mutation lease before deleting shared storage", async () => {
    const f = fixture({
      mutationLease: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await processKnowledgeDocumentDeletion(f.env, "doc-1");
    expect(result.state).toBe("pending");
    expect(f.kvPuts).toHaveLength(0);
    expect(f.deletedVectorIds).toHaveLength(0);
    expect(f.bucket.list).not.toHaveBeenCalled();
  });

  it("persists each semantic-cache page before deleting its Vectorize IDs and KV bodies", async () => {
    const f = fixture({ semanticCachePages: [["cache-a", "cache-b"], []] });
    const first = await processKnowledgeDocumentDeletion(f.env, "doc-1");
    expect(first.state).toBe("pending");
    expect(f.persistedIdsAtCacheDelete).toEqual(['["cache-a","cache-b"]']);
    expect(f.semanticCacheDeletedIds).toEqual([["cache-a", "cache-b"]]);
    expect(f.kvDeletes).toEqual(["sc:cache-a", "sc:cache-b"]);
    expect(f.operation.cache_cleanup_ids_json).toBe("[]");

    const second = await processKnowledgeDocumentDeletion(f.env, "doc-1");
    expect(second.state).toBe("complete");
    expect(f.operation.cache_cleanup_status).toBe("complete");
    expect(f.semanticCacheDeletedIds).toEqual([["cache-a", "cache-b"]]);
  });

  it("reopens a cache cleanup row completed by an older Worker version", async () => {
    const f = fixture();
    f.operation.state = "complete";
    f.operation.cache_generation_rotated_at = new Date().toISOString();
    f.operation.cache_generation_to_purge = "*";
    f.operation.cache_cleanup_status = "pending";
    const completed = await reconcileKnowledgeDocumentDeletions(f.env, 20);
    expect(completed).toBe(1);
    expect(f.operation.state).toBe("complete");
    expect(f.operation.cache_cleanup_status).toBe("complete");
  });
});
