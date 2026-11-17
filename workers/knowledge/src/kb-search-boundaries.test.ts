import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createKnowledgeSearchTrace, evaluateKnowledgeRetrieval } from "../../../infra/scripts/knowledge-retrieval-eval.mjs";
import worker from "./index.js";

function bindings(owned: boolean, pendingDeletion = false, ftsFails = false, searchFixture: {
  matches?: Array<{ id: string; score: number }>;
  chunkRows?: Array<Record<string, unknown>>;
  ftsRows?: Array<Record<string, unknown>>;
} = {}) {
  const run = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
  const query = vi.fn(async () => ({ matches: searchFixture.matches ?? [] }));
  const cacheQuery = vi.fn(async () => ({ matches: [{ id: "cached-answer", score: 0.999 }] }));
  const groundedCacheGet = vi.fn(async () => ({ createdAt: Date.now(), expiresAt: Date.now() + 60_000, hits: [{ id: "doc-1_chunk_0", content: "deleted content" }] }));
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      first: vi.fn(async () => sql.includes("SELECT 1 FROM spaces")
        ? owned ? { owned: 1 } : null
        : sql.includes("kb_document_deletion_operations")
          ? pendingDeletion ? { document_id: "doc-1" } : null
          : { config_json: "{}" }),
      all: vi.fn(async () => {
        if (ftsFails && sql.includes("kb_chunks_fts")) throw new Error("FTS unavailable");
        if (sql.includes("kb_chunks_fts")) return { results: (searchFixture.ftsRows ?? []).filter(row => row.source_state !== "stale" || !sql.includes("d.source_state='current'")) };
        if (sql.includes("SELECT k.*, d.title FROM kb_chunks")) return { results: (searchFixture.chunkRows ?? []).filter(row => row.source_state !== "stale" || !sql.includes("d.source_state='current'")) };
        return { results: [] };
      }),
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

  it("keeps semantic answer-cache reads disabled by default", async () => {
    const env = bindings(true);
    const response = await worker.fetch!(await searchRequest("policy"), env as never, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(env.cacheQuery).not.toHaveBeenCalled();
  });

  it("reports lexical unavailability while preserving permissioned dense search", async () => {
    const env = bindings(true, false, true);
    const response = await worker.fetch!(await searchRequest("policy"), env as never, {} as ExecutionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ retrieval_mode: "hybrid", lexical_search: "unavailable" });
    expect(env.query).toHaveBeenCalledOnce();
  });
});

describe("content-free retrieval evaluation trace", () => {
  it("scores actual local Knowledge route hits, exposes source revisions, and filters missing canonical rows", async () => {
    const currentId = "catalog-rx0042_chunk_0";
    const staleId = "policy-reagent-k_chunk_0";
    const forbiddenId = "private-procurement_chunk_0";
    const row = (id: string, sourceRevision: number, sourceState = "current") => ({
      id, tenant_id: "tenant-a", space_id: "space-b", project_id: "_space", required_role_rank: 0,
      content: `Synthetic indexed content for ${id}`, r2_key: `kb/${id}.txt`, byte_start: 0, byte_end: 32,
      line_start: 1, line_end: 1, heading_path: '["Page 2","Table 1"]', title: "Synthetic source", source_revision: sourceRevision,
      source_state: sourceState,
    });
    const runRoute = async (caseId: string, query: string, id: string, canonicalRows: Array<Record<string, unknown>>) => {
      const env = bindings(true, false, false, {
        matches: [{ id, score: 0.98 }, { id: forbiddenId, score: 0.97 }],
        chunkRows: canonicalRows,
        ftsRows: canonicalRows,
      });
      const response = await worker.fetch!(await searchRequest(query), env as never, {} as ExecutionContext);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        data: Array<{ chunk_id: string; score: number; citation: { chunk_id: string; source_revision?: number; heading_path?: string[] } | null }>;
        latency_ms: number;
      };
      return {
        env,
        result: createKnowledgeSearchTrace({ caseId, response: body, abstained: body.data.length === 0,
          latencyMs: body.latency_ms, costMicrosUsd: 0 }),
      };
    };
    const current = await runRoute("synthetic-exact-code", "Which catalog item uses code RX-0042?", currentId, [row(currentId, 2)]);
    const stale = await runRoute("synthetic-current-policy", "What is the current policy?", staleId, [row(staleId, 1)]);
    const noAnswer = await runRoute("synthetic-missing-answer", "Is stock guaranteed in 2035?", forbiddenId, []);
    expect(current.result.retrieved.map(({ chunkId }) => chunkId)).toEqual([currentId]);
    const routeWithProvenance = await worker.fetch!(await searchRequest("Which catalog item uses code RX-0042?"), bindings(true, false, false, {
      matches: [{ id: currentId, score: 0.98 }], chunkRows: [row(currentId, 2)], ftsRows: [row(currentId, 2)],
    }) as never, {} as ExecutionContext);
    await expect(routeWithProvenance.json()).resolves.toMatchObject({ data: [{ citation: { heading_path: ["Page 2", "Table 1"] } }] });
    expect(stale.result.retrieved[0]?.sourceVersion).toBe("1");
    expect(noAnswer.result.retrieved).toEqual([]);
    expect(noAnswer.env.query).toHaveBeenCalled();

    const report = evaluateKnowledgeRetrieval({ cases: [
      { recordType: "case", caseId: "synthetic-exact-code", language: "en", reviewStatus: "synthetic_unreviewed",
        query: "Which catalog item uses code RX-0042?", answerable: true, relevantChunkIds: [currentId],
        expectedCitationChunkIds: [currentId], expectedVersions: { [currentId]: "2" }, forbiddenChunkIds: [forbiddenId] },
      { recordType: "case", caseId: "synthetic-current-policy", language: "en", reviewStatus: "synthetic_unreviewed",
        query: "What is the current policy?", answerable: true, relevantChunkIds: [staleId],
        expectedCitationChunkIds: [staleId], expectedVersions: { [staleId]: "2" }, forbiddenChunkIds: [forbiddenId] },
      { recordType: "case", caseId: "synthetic-missing-answer", language: "en", reviewStatus: "synthetic_unreviewed",
        query: "Is stock guaranteed in 2035?", answerable: false, relevantChunkIds: [],
        expectedCitationChunkIds: [], expectedVersions: {}, forbiddenChunkIds: [forbiddenId] },
    ], results: [current.result, stale.result, noAnswer.result] });
    expect(report.metrics.recallAtK).toBe(1);
    expect(report.metrics.staleCitationCount).toBe(1);
    expect(report.metrics.forbiddenExposureCount).toBe(0);
    expect(report.readiness.acceptanceEligible).toBe(false);
    expect(JSON.stringify(report).includes("Which catalog item uses code RX-0042?")).toBe(false);
  });

  it("filters stale connector source lineage from dense and sparse candidates", async () => {
    const stale = { id: "connector_chunk_0", tenant_id: "tenant-a", space_id: "space-b", project_id: "_space",
      required_role_rank: 0, content: "revoked connector content", r2_key: "kb/revoked.txt", byte_start: 0, byte_end: 24,
      line_start: 1, line_end: 1, heading_path: "[]", title: "Revoked source", source_revision: 2, source_state: "stale" };
    const env = bindings(true, false, false, { matches: [{ id: stale.id, score: 0.99 }], chunkRows: [stale], ftsRows: [stale] });
    const response = await worker.fetch!(await searchRequest("revoked connector"), env as never, {} as ExecutionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [] });
    expect(env.query).toHaveBeenCalledOnce();
  });
});
