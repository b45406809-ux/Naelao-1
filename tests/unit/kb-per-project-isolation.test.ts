import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import knowledgeWorker from "../../workers/knowledge/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// WS-4: kb_documents was space-scoped only — a customer-bot project couldn't carry its own
// document KB isolated from the rest of the space. project_id IS NULL remains the pre-existing
// default (space-wide); an explicit project_id isolates a document to that project's own KB,
// both in D1 (list/filter) and in Vectorize (search never mixes project-scoped and space-wide
// results, or one project's results into another's).

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', suspension_reason TEXT, config_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '', plan_tier TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'active', suspension_reason TEXT);
`;
const KB_DOCUMENTS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0006_kb_documents.sql"), "utf8");
const KB_PROJECT_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0051_kb_documents_project.sql"), "utf8");
const KB_SECURITY_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0074_items_45_87_security_models.sql"), "utf8");

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, KB_DOCUMENTS_MIGRATION, KB_PROJECT_MIGRATION, KB_SECURITY_MIGRATION]);
  fakeDb.db.exec(`INSERT INTO spaces (id, tenant_id, status) VALUES ('space-1', 'tenant-1', 'active')`);
  fakeDb.db.exec(`INSERT INTO orgs (id, status) VALUES ('tenant-1', 'active')`);
  for (const projectId of ["proj-1", "proj-a", "proj-b"]) {
    fakeDb.db.exec(`INSERT INTO project_access (tenant_id, space_id, project_id, user_id, role_rank, visibility) VALUES ('tenant-1', 'space-1', '${projectId}', 'builder', 50, 'private')`);
  }

  // In-memory fake Vectorize: query() filters by the SAME flat-metadata semantics the real
  // Vectorize index uses (all filter fields ANDed, top-level $eq only).
  const vectorStore = new Map<string, { values: number[]; metadata: Record<string, unknown> }>();
  const vectors = {
    async upsert(items: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>) {
      for (const item of items) vectorStore.set(item.id, { values: item.values, metadata: item.metadata });
    },
    async query(_vec: number[], opts: { filter?: Record<string, { $eq: unknown }>; topK: number }) {
      const filter = opts.filter ?? {};
      const matches = [...vectorStore.entries()]
        .filter(([, v]) => Object.entries(filter).every(([k, cond]) => v.metadata[k] === cond.$eq))
        .slice(0, opts.topK)
        .map(([id, v]) => ({ id, score: 0.9, metadata: v.metadata }));
      return { matches };
    },
    async deleteByIds(ids: string[]) {
      for (const id of ids) vectorStore.delete(id);
    },
  };

  const r2Store = new Map<string, string>();
  const bucket = {
    async put(key: string, value: string) { r2Store.set(key, value); },
    async get(key: string) {
      if (!r2Store.has(key)) return null;
      const text = r2Store.get(key)!;
      return { async text() { return text; } };
    },
    async list(opts: { prefix?: string }) {
      const prefix = opts.prefix ?? "";
      const objects = [...r2Store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k }));
      return { objects, truncated: false };
    },
    async delete(key: string) { r2Store.delete(key); },
  };

  const ai = { async run() { return { data: [{ embedding: new Array(8).fill(0.1) }] }; } };
  const kv = { async get() { return null; }, async put() {}, async delete() {} };

  return {
    env: {
      PLATFORM_SECRET: SECRET,
      ENVIRONMENT: "test",
      PLATFORM_DB: fakeDb,
      KB_CACHE: kv,
      KB_VECTORS: vectors,
      KB_BUCKET: bucket,
      AI: ai,
    },
    r2Store,
  };
}

async function req(path: string, opts: { method?: string; body?: unknown } = {}): Promise<Request> {
  const token = await mintInternalToken(SECRET, "tenant-1");
  const headers: Record<string, string> = { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token, "x-naelao-role": "owner", "x-naelao-user-id": "builder" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://knowledge.naelao.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("knowledge worker — per-project KB isolation (WS-4)", () => {
  it("a project-scoped document is invisible in the default (space-wide) list", async () => {
    const { env } = makeEnv();
    await knowledgeWorker.fetch(
      await req("/spaces/space-1/kb/documents", { method: "POST", body: { title: "Project Doc", content: "hello world", project_id: "proj-1" } }),
      env as never, execCtx
    );
    const listRes = await knowledgeWorker.fetch(await req("/spaces/space-1/kb/documents"), env as never, execCtx);
    const body = await listRes.json() as { data: unknown[]; count: number };
    expect(body.count).toBe(0);
  });

  it("a project-scoped document IS visible when listing that project", async () => {
    const { env } = makeEnv();
    await knowledgeWorker.fetch(
      await req("/spaces/space-1/kb/documents", { method: "POST", body: { title: "Project Doc", content: "hello world", project_id: "proj-1" } }),
      env as never, execCtx
    );
    const listRes = await knowledgeWorker.fetch(await req("/spaces/space-1/kb/documents?project_id=proj-1"), env as never, execCtx);
    const body = await listRes.json() as { data: Array<{ title: string }>; count: number };
    expect(body.count).toBe(1);
    expect(body.data[0]!.title).toBe("Project Doc");
  });

  it("two different projects' documents never mix in either project's own list", async () => {
    const { env } = makeEnv();
    await knowledgeWorker.fetch(
      await req("/spaces/space-1/kb/documents", { method: "POST", body: { title: "Proj A Doc", content: "content a", project_id: "proj-a" } }),
      env as never, execCtx
    );
    await knowledgeWorker.fetch(
      await req("/spaces/space-1/kb/documents", { method: "POST", body: { title: "Proj B Doc", content: "content b", project_id: "proj-b" } }),
      env as never, execCtx
    );
    const listA = await (await knowledgeWorker.fetch(await req("/spaces/space-1/kb/documents?project_id=proj-a"), env as never, execCtx)).json() as { data: Array<{ title: string }> };
    const listB = await (await knowledgeWorker.fetch(await req("/spaces/space-1/kb/documents?project_id=proj-b"), env as never, execCtx)).json() as { data: Array<{ title: string }> };
    expect(listA.data.map((d) => d.title)).toEqual(["Proj A Doc"]);
    expect(listB.data.map((d) => d.title)).toEqual(["Proj B Doc"]);
  });

  it("kb/search on a project never returns space-wide document chunks, and vice versa", async () => {
    const { env } = makeEnv();
    await knowledgeWorker.fetch(
      await req("/spaces/space-1/kb/documents", { method: "POST", body: { title: "Space-wide Doc", content: "general knowledge" } }),
      env as never, execCtx
    );
    await knowledgeWorker.fetch(
      await req("/spaces/space-1/kb/documents", { method: "POST", body: { title: "Project Doc", content: "project-specific knowledge", project_id: "proj-1" } }),
      env as never, execCtx
    );

    const spaceWideSearch = await (await knowledgeWorker.fetch(await req("/spaces/space-1/kb/search?q=knowledge"), env as never, execCtx)).json() as { data: Array<{ doc_id: string }> };
    const projectSearch = await (await knowledgeWorker.fetch(await req("/spaces/space-1/kb/search?q=knowledge&project_id=proj-1"), env as never, execCtx)).json() as { data: Array<{ doc_id: string }> };

    expect(spaceWideSearch.data.length).toBeGreaterThan(0);
    expect(projectSearch.data.length).toBeGreaterThan(0);
    const spaceWideDocIds = new Set(spaceWideSearch.data.map((r) => r.doc_id));
    const projectDocIds = new Set(projectSearch.data.map((r) => r.doc_id));
    expect([...spaceWideDocIds].some((id) => projectDocIds.has(id))).toBe(false);
  });

  it("deleting a project-scoped document removes its R2 chunks under the project's own prefix", async () => {
    const { env, r2Store } = makeEnv();
    const created = await (await knowledgeWorker.fetch(
      await req("/spaces/space-1/kb/documents", { method: "POST", body: { title: "Proj Doc", content: "some content", project_id: "proj-1" } }),
      env as never, execCtx
    )).json() as { id: string };

    const r2KeysBefore = [...r2Store.keys()];
    expect(r2KeysBefore.some((k) => k.startsWith(`kb/space-1/proj-1/${created.id}/`))).toBe(true);

    await knowledgeWorker.fetch(await req(`/spaces/space-1/kb/documents/${created.id}`, { method: "DELETE" }), env as never, execCtx);
    const r2KeysAfter = [...r2Store.keys()];
    expect(r2KeysAfter.some((k) => k.startsWith(`kb/space-1/proj-1/${created.id}/`))).toBe(false);
  });
});
