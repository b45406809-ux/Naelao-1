import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";
import { mintInternalToken } from "@naelao/http";
import worker from "../src/index.js";
import { revisionExternalPublicationsForDocument } from "../src/external-publication-lifecycle.js";

const secret = "knowledge-publication-revision-sql-test-secret";
const migration = (filename: string) => readFileSync(new URL(`../../../infra/migrations/${filename}`, import.meta.url), "utf8");

function harness(options: { duringVectorQuery?: (db: ReturnType<typeof createFakeD1>["db"]) => void } = {}) {
  const db = createFakeD1([
    "CREATE TABLE orgs(id TEXT PRIMARY KEY,status TEXT NOT NULL)",
    "CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,status TEXT NOT NULL,config_json TEXT)",
    "CREATE TABLE project_access(project_id TEXT NOT NULL,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,visibility TEXT NOT NULL,role_rank INTEGER NOT NULL,PRIMARY KEY(project_id,user_id,tenant_id,space_id))",
    "CREATE TABLE kb_documents(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT,status TEXT NOT NULL,title TEXT NOT NULL)",
    "CREATE TABLE kb_chunks(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,deleted_at TEXT)",
    migration("0104_kb_external_publications.sql"),
    migration("0265_knowledge_publication_revisions.sql"),
  ]);
  db.db.exec(`INSERT INTO orgs VALUES('tenant-a','active');
    INSERT INTO spaces VALUES('space-a','tenant-a','active',NULL);
    INSERT INTO project_access VALUES('project-a','owner-a','tenant-a','space-a','private',50);
    INSERT INTO project_access VALUES('project-a','member-a','tenant-a','space-a','private',20);
    INSERT INTO kb_documents VALUES('doc-a','tenant-a','space-a','project-a','indexed','Document A');
    INSERT INTO kb_documents VALUES('doc-b','tenant-a','space-a','project-a','indexed','Document B');
    INSERT INTO kb_documents VALUES('foreign-doc','tenant-a','space-a','project-b','indexed','Foreign document');
    INSERT INTO kb_chunks VALUES('chunk-a','doc-a','tenant-a','space-a','project-a','approved fact','content-hash',NULL);`);
  const vectorQuery = vi.fn(async () => {
    options.duringVectorQuery?.(db.db);
    return { matches: [{ id: "chunk-a", score: 0.9 }] };
  });
  const env = { ENVIRONMENT: "test", PLATFORM_SECRET: secret, PLATFORM_DB: db as never,
    KB_VECTORS: { query: vectorQuery }, AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) } } as never;
  return { db, env, vectorQuery };
}

async function call(path: string, body?: unknown, method = body === undefined ? "GET" : "PUT", role = "owner") {
  return new Request(`https://knowledge.test${path}`, {
    method,
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": `${role}-a`,
      "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("revisioned external Knowledge publication SQL", () => {
  it("atomically replaces source membership, fences stale edits and pins retrieval to the approved version", async () => {
    const h = harness();
    const path = "/spaces/space-a/kb/projects/project-a/external-publications/course_material";
    const first = await worker.fetch(await call(path, { name: "Course material", document_ids: ["doc-a"], expected_revision: 0 }), h.env, {} as ExecutionContext);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ revision: 1, document_ids: ["doc-a"] });

    const listed = await worker.fetch(await call("/internal/spaces/space-a/kb/projects/project-a/external-publications"), h.env, {} as ExecutionContext);
    expect(await listed.json()).toEqual({ publications: [{ id: "course_material", revision: 1 }] });

    const staleEdit = await worker.fetch(await call(path, { name: "Stale", document_ids: ["doc-b"], expected_revision: 0 }), h.env, {} as ExecutionContext);
    expect(staleEdit.status).toBe(409);
    expect(h.db.db.prepare("SELECT document_id,publication_revision FROM kb_external_publication_documents").all()).toEqual([
      { document_id: "doc-a", publication_revision: 1 },
    ]);

    const changed = await worker.fetch(await call(path, { name: "Course material", document_ids: ["doc-b"], expected_revision: 1 }), h.env, {} as ExecutionContext);
    expect(changed.status).toBe(200);
    await expect(changed.json()).resolves.toMatchObject({ revision: 2, document_ids: ["doc-b"] });
    expect(h.db.db.prepare("SELECT document_id,publication_revision FROM kb_external_publication_documents").all()).toEqual([
      { document_id: "doc-b", publication_revision: 2 },
    ]);

    const oldGrantSearch = await worker.fetch(await call("/internal/spaces/space-a/kb/projects/project-a/external-search",
      { publication_id: "course_material", publication_revision: 1, query: "course facts" }, "POST"), h.env, {} as ExecutionContext);
    expect(oldGrantSearch.status).toBe(404);
    expect(h.vectorQuery).not.toHaveBeenCalled();

    const crossProject = await worker.fetch(await call(path, { name: "Course material", document_ids: ["foreign-doc"], expected_revision: 2 }), h.env, {} as ExecutionContext);
    expect(crossProject.status).toBe(400);
    const staleDelete = await worker.fetch(await call(path, { expected_revision: 1 }, "DELETE"), h.env, {} as ExecutionContext);
    expect(staleDelete.status).toBe(409);
    const deleted = await worker.fetch(await call(path, { expected_revision: 2 }, "DELETE"), h.env, {} as ExecutionContext);
    expect(deleted.status).toBe(200);
    expect(h.db.db.prepare("SELECT * FROM kb_external_publication_documents").all()).toEqual([]);
  });

  it("rechecks the collection revision after vector ranking before returning content", async () => {
    let changed = false;
    const h = harness({ duringVectorQuery: db => {
      if (changed) return;
      changed = true;
      db.prepare("UPDATE kb_external_publications SET revision=revision+1 WHERE id='course_material'").run();
      db.prepare("UPDATE kb_external_publication_documents SET publication_revision=publication_revision+1 WHERE publication_id='course_material'").run();
    } });
    const create = await worker.fetch(await call("/spaces/space-a/kb/projects/project-a/external-publications/course_material",
      { name: "Course material", document_ids: ["doc-a"], expected_revision: 0 }), h.env, {} as ExecutionContext);
    expect(create.status).toBe(200);
    const response = await worker.fetch(await call("/internal/spaces/space-a/kb/projects/project-a/external-search",
      { publication_id: "course_material", publication_revision: 1, query: "approved fact" }, "POST"), h.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [] });
    expect(h.vectorQuery).toHaveBeenCalledTimes(1);
  });

  it("invalidates exact installation grants when a published source changes or is removed", async () => {
    const h = harness();
    const path = "/spaces/space-a/kb/projects/project-a/external-publications/course_material";
    const created = await worker.fetch(await call(path, { name: "Course material", document_ids: ["doc-a", "doc-b"], expected_revision: 0 }), h.env, {} as ExecutionContext);
    expect(created.status).toBe(200);

    await h.db.batch(revisionExternalPublicationsForDocument(h.db as never,
      { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", documentId: "doc-a", updatedAt: "2026-11-16T00:00:00.000Z" }) as never);
    expect(h.db.db.prepare("SELECT revision FROM kb_external_publications WHERE id='course_material'").get()).toEqual({ revision: 2 });
    expect(h.db.db.prepare("SELECT document_id,publication_revision FROM kb_external_publication_documents ORDER BY document_id").all()).toEqual([
      { document_id: "doc-a", publication_revision: 2 }, { document_id: "doc-b", publication_revision: 2 },
    ]);

    await h.db.batch(revisionExternalPublicationsForDocument(h.db as never,
      { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", documentId: "doc-a", updatedAt: "2026-11-16T00:01:00.000Z" }) as never);
    await h.db.prepare("DELETE FROM kb_external_publication_documents WHERE publication_id=? AND document_id=?")
      .bind("course_material", "doc-a").run();
    const current = await worker.fetch(await call("/spaces/space-a/kb/projects/project-a/external-publications"), h.env, {} as ExecutionContext);
    await expect(current.json()).resolves.toMatchObject({ publications: [{ id: "course_material", revision: 3, document_ids: ["doc-b"] }] });
  });
});
