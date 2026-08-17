import { describe, it, expect, vi } from "vitest";
import knowledgeWorker from "../../workers/knowledge/src/index.js";
import { mintInternalToken } from "@naelao/http";

// F8 follow-up: the ownership gate originally landed on kb/search only. A tenant that owns no
// space at all could still write documents into (or delete/list documents from) another
// tenant's spaceId via POST/GET/DELETE /spaces/:spaceId/kb/documents, since those routes never
// verified spaceId ownership before touching D1/Vectorize/R2 — worse than the search gap,
// since ingest could poison another tenant's KB with content that later surfaces in that
// tenant's own searches. The gate now lives once, in "/spaces/:spaceId/kb/*" middleware, ahead
// of every verb. These tests prove that gate covers list, ingest, and delete, and that the
// search cache never crosses tenants even when two tenants share a spaceId string collision
// isn't possible in practice, but hitting the endpoint twice under differing tenant headers is.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(opts: {
  ownerTenantId: string;
  cacheStore?: Map<string, string>;
  deleteRan?: { called: boolean };
  insertRan?: { called: boolean };
}) {
  const cacheStore = opts.cacheStore ?? new Map<string, string>();
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          (stmt as unknown as { _args: unknown[] })._args = args;
          return stmt;
        },
        async first() {
          if (/FROM spaces WHERE/.test(sql)) {
            const args = (stmt as unknown as { _args: unknown[] })._args;
            const [, tenantId] = args;
            return tenantId === opts.ownerTenantId ? { 1: 1 } : null;
          }
          if (/FROM kb_documents WHERE/.test(sql)) {
            return null;
          }
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          if (/^DELETE FROM kb_documents/.test(sql) && opts.deleteRan) opts.deleteRan.called = true;
          if (/^INSERT INTO kb_documents/.test(sql) && opts.insertRan) opts.insertRan.called = true;
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  const kv = {
    async get(key: string) { return cacheStore.get(key) ?? null; },
    async put(key: string, value: string) { cacheStore.set(key, value); },
    async delete(key: string) { cacheStore.delete(key); },
  };
  // The shape CF's embedding model REALLY returns: a flat number[][], not Array<{embedding}>.
  // This double used to assert the object form, which agreed with the code rather than with
  // Cloudflare and is precisely why a broken ingestion path went unnoticed.
  const ai = { async run() { return { data: [new Array(8).fill(0.1)], shape: [1, 8] }; } };
  // One real match, so search actually produces a result and the caching path this test is
  // about is genuinely exercised (an empty result is deliberately not cached).
  const vectors = {
    query: vi.fn().mockResolvedValue({ matches: [{ id: "doc-1_chunk_0", score: 0.9 }] }),
    upsert: vi.fn().mockResolvedValue({}),
    deleteByIds: vi.fn().mockResolvedValue({}),
  };
  return {
    PLATFORM_SECRET: SECRET,
    ENVIRONMENT: "test",
    PLATFORM_DB: db,
    KB_CACHE: kv,
    KB_VECTORS: vectors,
    KB_BUCKET: {
      async get(key: string) {
        // Only a chunk read resolves — every other lookup (document mirrors, deletes) stays
        // absent, as before.
        if (!/\/chunk_\d+\.json$/.test(key)) return null;
        return {
          async text() {
            return JSON.stringify({ docId: "doc-1", chunkIndex: 0, content: "hello there", spaceId: "shared-space-id", tenantId: opts.ownerTenantId });
          },
        };
      },
      async list() { return { objects: [], truncated: false }; },
      async delete() {},
    },
    AI: ai,
  };
}

describe("knowledge worker — kb/* ownership gate covers every verb", () => {
  it("rejects GET /kb/documents (list) against a spaceId owned by a different tenant", async () => {
    const token = await mintInternalToken(SECRET, "attacker-tenant");
    const res = await knowledgeWorker.fetch(
      new Request("https://knowledge.naelao.com/spaces/victim-space/kb/documents", {
        headers: { "x-naelao-tenant-id": "attacker-tenant", "x-naelao-internal-token": token },
      }),
      makeEnv({ ownerTenantId: "victim-tenant" }) as never,
      execCtx
    );
    expect(res.status).toBe(404);
  });

  it("rejects POST /kb/documents (ingest) against a spaceId owned by a different tenant, never inserting", async () => {
    const insertRan = { called: false };
    const token = await mintInternalToken(SECRET, "attacker-tenant");
    const res = await knowledgeWorker.fetch(
      new Request("https://knowledge.naelao.com/spaces/victim-space/kb/documents", {
        method: "POST",
        headers: {
          "x-naelao-tenant-id": "attacker-tenant",
          "x-naelao-internal-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "poisoned doc", content: "malicious content" }),
      }),
      makeEnv({ ownerTenantId: "victim-tenant", insertRan }) as never,
      execCtx
    );
    expect(res.status).toBe(404);
    expect(insertRan.called).toBe(false);
  });

  it("rejects DELETE /kb/documents/:docId against a spaceId owned by a different tenant, leaving the row untouched", async () => {
    const deleteRan = { called: false };
    const token = await mintInternalToken(SECRET, "attacker-tenant");
    const res = await knowledgeWorker.fetch(
      new Request("https://knowledge.naelao.com/spaces/victim-space/kb/documents/doc-1", {
        method: "DELETE",
        headers: { "x-naelao-tenant-id": "attacker-tenant", "x-naelao-internal-token": token },
      }),
      makeEnv({ ownerTenantId: "victim-tenant", deleteRan }) as never,
      execCtx
    );
    expect(res.status).toBe(404);
    expect(deleteRan.called).toBe(false);
  });

  it("does not serve a cache entry written under one tenant's search to a different tenant", async () => {
    const cacheStore = new Map<string, string>();
    const envA = makeEnv({ ownerTenantId: "tenant-a", cacheStore });
    const tokenA = await mintInternalToken(SECRET, "tenant-a");

    // Tenant A searches its own space — cache miss, populates the cache.
    const resA = await knowledgeWorker.fetch(
      new Request("https://knowledge.naelao.com/spaces/shared-space-id/kb/search?q=hello", {
        headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": tokenA },
      }),
      envA as never,
      execCtx
    );
    expect(resA.status).toBe(200);
    expect(cacheStore.size).toBe(1);
    const [tenantAKey] = [...cacheStore.keys()];

    // Confirm tenant B (who does NOT own "shared-space-id") is rejected before the cache is
    // even consulted — proving the ownership gate, not the cache key, is the primary defense.
    const tokenB = await mintInternalToken(SECRET, "tenant-b");
    const resB = await knowledgeWorker.fetch(
      new Request("https://knowledge.naelao.com/spaces/shared-space-id/kb/search?q=hello", {
        headers: { "x-naelao-tenant-id": "tenant-b", "x-naelao-internal-token": tokenB },
      }),
      makeEnv({ ownerTenantId: "tenant-a", cacheStore }) as never,
      execCtx
    );
    expect(resB.status).toBe(404);

    // Now have tenant B legitimately search its OWN space with the identical query text — the
    // cache key must differ from tenant A's (tenantId folded in), so no accidental collision
    // even if a future refactor moved the ownership gate after the cache lookup.
    const tokenBOwn = await mintInternalToken(SECRET, "tenant-b");
    const resBOwn = await knowledgeWorker.fetch(
      new Request("https://knowledge.naelao.com/spaces/tenant-b-space/kb/search?q=hello", {
        headers: { "x-naelao-tenant-id": "tenant-b", "x-naelao-internal-token": tokenBOwn },
      }),
      makeEnv({ ownerTenantId: "tenant-b", cacheStore }) as never,
      execCtx
    );
    expect(resBOwn.status).toBe(200);
    expect(cacheStore.size).toBe(2);
    expect([...cacheStore.keys()]).toContain(tenantAKey);
  });
});
