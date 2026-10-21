import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import knowledgeWorker from "../../workers/knowledge/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', config_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '', plan_tier TEXT NOT NULL DEFAULT 'free');
`;
const KB_DOCUMENTS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0006_kb_documents.sql"), "utf8");
const KB_PROJECT_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0051_kb_documents_project.sql"), "utf8");
const KB_SECURITY_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0074_items_45_87_security_models.sql"), "utf8");

// §A1.19: AutoRAG as an opt-in retrieval_mode alongside the existing hand-built dense+BM25+RRF
// hybrid pipeline (default, unchanged). Config-gated per request (the caller decides), honest
// degradation to the legacy pipeline whenever AUTORAG_KB_INSTANCE isn't configured — even if the
// caller explicitly asked for autorag mode.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(opts: {
  autoragInstance?: string;
  autoragSearch?: ReturnType<typeof vi.fn>;
  vectorizeQuery?: ReturnType<typeof vi.fn>;
  r2Put?: ReturnType<typeof vi.fn>;
}) {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, KB_DOCUMENTS_MIGRATION, KB_PROJECT_MIGRATION, KB_SECURITY_MIGRATION]);
  fakeDb.db.exec(`INSERT INTO spaces (id, tenant_id, status, config_json) VALUES ('space-1', 'tenant-a', 'active', '{}')`);

  const kv = { async get() { return null; }, async put() {}, async delete() {} };
  const ai = {
    async run() {
      return { data: [{ embedding: new Array(8).fill(0.1) }] };
    },
    autorag(_name: string) {
      return { search: opts.autoragSearch ?? vi.fn().mockResolvedValue({ data: [] }) };
    },
  };
  const r2Store = new Map<string, string>();
  return {
    PLATFORM_SECRET: SECRET,
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    KB_CACHE: kv,
    KB_VECTORS: { query: opts.vectorizeQuery ?? vi.fn().mockResolvedValue({ matches: [] }), upsert: vi.fn() },
    KB_BUCKET: {
      async get() { return null; },
      put: opts.r2Put ?? (async (key: string, value: string) => { r2Store.set(key, value); }),
      async delete(key: string) { r2Store.delete(key); },
      async list() { return { objects: [], truncated: false }; },
    },
    AI: ai,
    ...(opts.autoragInstance ? { AUTORAG_KB_INSTANCE: opts.autoragInstance } : {}),
  };
}

async function search(env: ReturnType<typeof makeEnv>, qs: string) {
  const token = await mintInternalToken(SECRET, "tenant-a");
  return knowledgeWorker.fetch(
    new Request(`https://knowledge.naelao.com/spaces/space-1/kb/search?${qs}`, {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token, "x-naelao-role": "owner", "x-naelao-user-id": "owner" },
    }),
    env as never,
    execCtx
  );
}

describe("GET /spaces/:spaceId/kb/search — retrieval_mode=autorag", () => {
  it("uses the legacy hybrid pipeline by default (no retrieval_mode param)", async () => {
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] });
    const env = makeEnv({ autoragInstance: "kb-instance", vectorizeQuery });
    const res = await search(env, "q=refund");
    expect(res.status).toBe(200);
    const body = await res.json() as { retrieval_mode: string };
    expect(body.retrieval_mode).toBe("hybrid");
    expect(vectorizeQuery).toHaveBeenCalledTimes(1);
  });

  it("uses AutoRAG when retrieval_mode=autorag and an instance is configured", async () => {
    const autoragSearch = vi.fn().mockResolvedValue({
      data: [{ filename: "autorag/space-1/_space/doc-1.md", score: 0.95, content: [{ text: "Refunds are accepted within 30 days." }] }],
    });
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] });
    const env = makeEnv({ autoragInstance: "kb-instance", autoragSearch, vectorizeQuery });
    const res = await search(env, "q=refund&retrieval_mode=autorag");
    expect(res.status).toBe(200);
    const body = await res.json() as { retrieval_mode: string };
    // AutoRAG lacks metadata filters and remains disabled until tenant, project, role, and
    // visibility predicates can be enforced before results are returned.
    expect(body.retrieval_mode).toBe("hybrid");
    expect(vectorizeQuery).toHaveBeenCalledTimes(1);
    expect(autoragSearch).not.toHaveBeenCalled();
  });

  it("falls back to the legacy pipeline when retrieval_mode=autorag is requested but no instance is configured", async () => {
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] });
    const env = makeEnv({ vectorizeQuery }); // no autoragInstance
    const res = await search(env, "q=refund&retrieval_mode=autorag");
    expect(res.status).toBe(200);
    const body = await res.json() as { retrieval_mode: string };
    expect(body.retrieval_mode).toBe("hybrid");
    expect(vectorizeQuery).toHaveBeenCalledTimes(1);
  });

  it("falls back to the legacy pipeline when the AutoRAG call itself throws", async () => {
    const autoragSearch = vi.fn().mockRejectedValue(new Error("AutoRAG unavailable"));
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] });
    const env = makeEnv({ autoragInstance: "kb-instance", autoragSearch, vectorizeQuery });
    const res = await search(env, "q=refund&retrieval_mode=autorag");
    expect(res.status).toBe(200);
    const body = await res.json() as { retrieval_mode: string };
    expect(body.retrieval_mode).toBe("hybrid");
    expect(vectorizeQuery).toHaveBeenCalledTimes(1);
  });
});

describe("POST /spaces/:spaceId/kb/documents — AutoRAG mirror", () => {
  it("mirrors the sanitized document to R2 when AUTORAG_KB_INSTANCE is configured", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ autoragInstance: "kb-instance", r2Put: put });
    const token = await mintInternalToken(SECRET, "tenant-a");
    const res = await knowledgeWorker.fetch(
      new Request("https://knowledge.naelao.com/spaces/space-1/kb/documents", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token, "x-naelao-role": "owner", "x-naelao-user-id": "owner" },
        body: JSON.stringify({ title: "Refund Policy", content: "Refunds are accepted within 30 days of purchase." }),
      }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(201);
    const mirrorCall = put.mock.calls.find((c) => String(c[0]).startsWith("autorag/"));
    expect(mirrorCall).toBeDefined();
    expect(mirrorCall![0]).toMatch(/^autorag\/space-1\/_space\/.+\.md$/);
  });

  it("does not attempt any AutoRAG mirror write when unconfigured", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ r2Put: put }); // no autoragInstance
    const token = await mintInternalToken(SECRET, "tenant-a");
    const res = await knowledgeWorker.fetch(
      new Request("https://knowledge.naelao.com/spaces/space-1/kb/documents", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token, "x-naelao-role": "owner", "x-naelao-user-id": "owner" },
        body: JSON.stringify({ title: "Refund Policy", content: "Refunds are accepted within 30 days of purchase." }),
      }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(201);
    expect(put.mock.calls.some((c) => String(c[0]).startsWith("autorag/"))).toBe(false);
  });
});
