import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";
import { mintInternalToken } from "@naelao/http";
import worker from "../src/index.js";
import { revisionExternalPublicationsForDocument } from "../src/external-publication-lifecycle.js";

const secret = "knowledge-publication-revision-sql-test-secret";
const migration = (filename: string) => readFileSync(new URL(`../../../infra/migrations/${filename}`, import.meta.url), "utf8");

function harness(options: { duringVectorQuery?: (db: ReturnType<typeof createFakeD1>["db"]) => void; applyAuditMigration?: boolean } = {}) {
  const db = createFakeD1([
    "CREATE TABLE orgs(id TEXT PRIMARY KEY,status TEXT NOT NULL)",
    "CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,status TEXT NOT NULL,config_json TEXT)",
    "CREATE TABLE project_access(project_id TEXT NOT NULL,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,visibility TEXT NOT NULL,role_rank INTEGER NOT NULL,PRIMARY KEY(project_id,user_id,tenant_id,space_id))",
    "CREATE TABLE kb_documents(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT,status TEXT NOT NULL,title TEXT NOT NULL)",
    "ALTER TABLE kb_documents ADD COLUMN source_adapter TEXT NOT NULL DEFAULT 'manual'",
    "ALTER TABLE kb_documents ADD COLUMN source_state TEXT NOT NULL DEFAULT 'current'",
    "ALTER TABLE kb_documents ADD COLUMN source_connection_ref TEXT",
    "CREATE TABLE website_connections(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT,status TEXT NOT NULL)",
    "CREATE TABLE kb_chunks(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,deleted_at TEXT)",
    migration("0104_kb_external_publications.sql"),
    migration("0265_knowledge_publication_revisions.sql"),
    migration("0268_knowledge_publication_archive.sql"),
    ...(options.applyAuditMigration === false ? [] : [migration("0269_knowledge_publication_audit_and_tombstones.sql")]),
  ]);
  db.db.exec(`INSERT INTO orgs VALUES('tenant-a','active');
    INSERT INTO spaces VALUES('space-a','tenant-a','active',NULL);
    INSERT INTO project_access VALUES('project-a','owner-a','tenant-a','space-a','private',50);
    INSERT INTO project_access VALUES('project-a','member-a','tenant-a','space-a','private',20);
    INSERT INTO kb_documents(id,tenant_id,space_id,project_id,status,title) VALUES('doc-a','tenant-a','space-a','project-a','indexed','Document A');
    INSERT INTO kb_documents(id,tenant_id,space_id,project_id,status,title) VALUES('doc-b','tenant-a','space-a','project-a','indexed','Document B');
    INSERT INTO kb_documents(id,tenant_id,space_id,project_id,status,title) VALUES('foreign-doc','tenant-a','space-a','project-b','indexed','Foreign document');
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
  it("preserves existing lifecycle receipts when the event ledger adds publication and delete actions", () => {
    const h = harness({ applyAuditMigration: false });
    h.db.db.exec(`INSERT INTO kb_external_publication_events
      (event_id,tenant_id,space_id,project_id,publication_id,actor_id,action,from_revision,to_revision,created_at)
      VALUES('event-archive','tenant-a','space-a','project-a','course_material','owner-a','archived',1,2,'2026-11-16T00:00:00.000Z')`);
    h.db.db.exec(migration("0269_knowledge_publication_audit_and_tombstones.sql"));
    h.db.db.exec(`INSERT INTO kb_external_publication_events
      (event_id,tenant_id,space_id,project_id,publication_id,actor_id,action,from_revision,to_revision,created_at)
      VALUES('event-delete','tenant-a','space-a','project-a','course_material','owner-a','deleted',2,3,'2026-11-16T00:01:00.000Z')`);
    expect(h.db.db.prepare("SELECT action,from_revision,to_revision FROM kb_external_publication_events ORDER BY to_revision").all())
      .toEqual([{ action: "archived", from_revision: 1, to_revision: 2 }, { action: "deleted", from_revision: 2, to_revision: 3 }]);
  });

  it("atomically replaces source membership, fences stale edits and pins retrieval to the approved version", async () => {
    const h = harness();
    const path = "/spaces/space-a/kb/projects/project-a/external-publications/course_material";
    const first = await worker.fetch(await call(path, { name: "Course material", document_ids: ["doc-a"], expected_revision: 0 }), h.env, {} as ExecutionContext);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ revision: 1, document_ids: ["doc-a"] });

    const listed = await worker.fetch(await call("/internal/spaces/space-a/kb/projects/project-a/external-publications"), h.env, {} as ExecutionContext);
    expect(await listed.json()).toEqual({ publications: [{ id: "course_material", revision: 1 }] });

    const discovery = await worker.fetch(await call("/spaces/space-a/kb/projects/project-a/external-publications", undefined, "GET", "member"), h.env, {} as ExecutionContext);
    expect(discovery.headers.get("cache-control")).toBe("private, no-store");
    await expect(discovery.json()).resolves.toEqual({ publications: [{ id: "course_material", name: "Course material", updated_at: expect.any(String), revision: 1, archived: false, document_count: 1 }] });
    const sources = await worker.fetch(await call(`${path}/sources`, undefined, "GET", "member"), h.env, {} as ExecutionContext);
    expect(sources.headers.get("cache-control")).toBe("private, no-store");
    await expect(sources.json()).resolves.toEqual({ publication_id: "course_material", revision: 1, document_ids: ["doc-a"] });
    const outsideSources = await worker.fetch(await call(path.replace("project-a", "project-b") + "/sources", undefined, "GET", "member"), h.env, {} as ExecutionContext);
    expect(outsideSources.status).toBe(404);

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
    const deletedHistory = await worker.fetch(await call(`${path}/events`), h.env, {} as ExecutionContext);
    expect(deletedHistory.status).toBe(200);
    await expect(deletedHistory.json()).resolves.toMatchObject({ events: [
      { action: "deleted", from_revision: 2, to_revision: 3 },
      { action: "updated", from_revision: 1, to_revision: 2 },
      { action: "published", from_revision: 0, to_revision: 1 },
    ] });
    const reusedId = await worker.fetch(await call(path, { name: "New collection", document_ids: ["doc-a"], expected_revision: 0 }), h.env, {} as ExecutionContext);
    expect(reusedId.status).toBe(409);
    await expect(reusedId.json()).resolves.toMatchObject({ error_code: "knowledge_publication_id_retired" });
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

  it("removes a revoked website source from published discovery and retrieval", async () => {
    const h = harness();
    h.db.db.exec(`INSERT INTO website_connections VALUES('website-a','tenant-a','space-a','project-a','active');
      UPDATE kb_documents SET source_adapter='website',source_state='current',source_connection_ref='website-a' WHERE id='doc-a';`);
    const path = "/spaces/space-a/kb/projects/project-a/external-publications/course_material";
    const created = await worker.fetch(await call(path, { name: "Course material", document_ids: ["doc-a"], expected_revision: 0 }), h.env, {} as ExecutionContext);
    expect(created.status).toBe(200);

    const liveSearch = await worker.fetch(await call("/internal/spaces/space-a/kb/projects/project-a/external-search",
      { publication_id: "course_material", publication_revision: 1, query: "approved fact" }, "POST"), h.env, {} as ExecutionContext);
    expect(liveSearch.status).toBe(200);
    expect(h.vectorQuery).toHaveBeenCalledOnce();

    h.db.db.exec("UPDATE website_connections SET status='revoked' WHERE id='website-a'");
    const revokedSearch = await worker.fetch(await call("/internal/spaces/space-a/kb/projects/project-a/external-search",
      { publication_id: "course_material", publication_revision: 1, query: "approved fact" }, "POST"), h.env, {} as ExecutionContext);
    expect(revokedSearch.status).toBe(200);
    await expect(revokedSearch.json()).resolves.toMatchObject({ data: [] });
    expect(h.vectorQuery).toHaveBeenCalledOnce();
    const sourceRead = await worker.fetch(await call(`${path}/sources`, undefined, "GET", "member"), h.env, {} as ExecutionContext);
    await expect(sourceRead.json()).resolves.toMatchObject({ document_ids: [] });
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
    await expect(current.json()).resolves.toMatchObject({ publications: [{ id: "course_material", revision: 3, document_count: 1 }] });
  });

  it("archives with a revision fence, drops active membership and requires explicit republish before discovery", async () => {
    const h = harness();
    const path = "/spaces/space-a/kb/projects/project-a/external-publications/course_material";
    const created = await worker.fetch(await call(path, { name: "Course material", document_ids: ["doc-a"], expected_revision: 0 }), h.env, {} as ExecutionContext);
    expect(created.status).toBe(200);

    const archived = await worker.fetch(await call(`${path}/archive`, { expected_revision: 1, archived: true }, "PUT"), h.env, {} as ExecutionContext);
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({ archived: true, revision: 2 });
    expect(h.db.db.prepare("SELECT * FROM kb_external_publication_documents").all()).toEqual([]);
    expect(h.db.db.prepare("SELECT actor_id,action,from_revision,to_revision FROM kb_external_publication_events ORDER BY to_revision").all())
      .toEqual([{ actor_id: "owner-a", action: "published", from_revision: 0, to_revision: 1 },
        { actor_id: "owner-a", action: "archived", from_revision: 1, to_revision: 2 }]);
    const archiveReplay = await worker.fetch(await call(`${path}/archive`, { expected_revision: 2, archived: true }, "PUT"), h.env, {} as ExecutionContext);
    await expect(archiveReplay.json()).resolves.toMatchObject({ archived: true, revision: 2 });
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM kb_external_publication_events").get()).toEqual({ count: 2 });
    const history = await worker.fetch(await call(`${path}/events`), h.env, {} as ExecutionContext);
    expect(history.headers.get("cache-control")).toBe("private, no-store");
    await expect(history.json()).resolves.toMatchObject({ publication_id: "course_material", events: [
      { actor_id: "owner-a", action: "archived", from_revision: 1, to_revision: 2 },
      { actor_id: "owner-a", action: "published", from_revision: 0, to_revision: 1 },
    ] });
    const memberHistory = await worker.fetch(await call(`${path}/events`, undefined, "GET", "member"), h.env, {} as ExecutionContext);
    expect(memberHistory.status).toBe(403);
    const crossProjectHistory = await worker.fetch(await call(path.replace("project-a", "project-b") + "/events", undefined, "GET", "owner"), h.env, {} as ExecutionContext);
    expect(crossProjectHistory.status).toBe(404);
    const ownerList = await worker.fetch(await call("/spaces/space-a/kb/projects/project-a/external-publications"), h.env, {} as ExecutionContext);
    await expect(ownerList.json()).resolves.toMatchObject({ publications: [{ id: "course_material", archived: true, revision: 2, document_count: 0 }] });
    const archivedSources = await worker.fetch(await call(`${path}/sources`), h.env, {} as ExecutionContext);
    expect(archivedSources.status).toBe(404);
    const currentGrants = await worker.fetch(await call("/internal/spaces/space-a/kb/projects/project-a/external-publications"), h.env, {} as ExecutionContext);
    await expect(currentGrants.json()).resolves.toEqual({ publications: [] });

    const archivedSearch = await worker.fetch(await call("/internal/spaces/space-a/kb/projects/project-a/external-search",
      { publication_id: "course_material", publication_revision: 2, query: "approved fact" }, "POST"), h.env, {} as ExecutionContext);
    expect(archivedSearch.status).toBe(404);
    expect(h.vectorQuery).not.toHaveBeenCalled();
    const archivedEdit = await worker.fetch(await call(path, { name: "Course material", document_ids: ["doc-b"], expected_revision: 2 }), h.env, {} as ExecutionContext);
    expect(archivedEdit.status).toBe(409);
    await expect(archivedEdit.json()).resolves.toMatchObject({ error_code: "knowledge_publication_archived" });

    const restored = await worker.fetch(await call(`${path}/archive`, { expected_revision: 2, archived: false }, "PUT"), h.env, {} as ExecutionContext);
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({ archived: false, revision: 3 });
    expect(h.db.db.prepare("SELECT actor_id,action,from_revision,to_revision FROM kb_external_publication_events ORDER BY to_revision").all())
      .toEqual([{ actor_id: "owner-a", action: "published", from_revision: 0, to_revision: 1 },
        { actor_id: "owner-a", action: "archived", from_revision: 1, to_revision: 2 },
        { actor_id: "owner-a", action: "restored_as_draft", from_revision: 2, to_revision: 3 }]);
    const restoredHistory = await worker.fetch(await call(`${path}/events`), h.env, {} as ExecutionContext);
    await expect(restoredHistory.json()).resolves.toMatchObject({ events: [
      { action: "restored_as_draft", from_revision: 2, to_revision: 3 },
      { action: "archived", from_revision: 1, to_revision: 2 },
      { action: "published", from_revision: 0, to_revision: 1 },
    ] });
    const restoredGrantDirectory = await worker.fetch(await call("/internal/spaces/space-a/kb/projects/project-a/external-publications"), h.env, {} as ExecutionContext);
    await expect(restoredGrantDirectory.json()).resolves.toEqual({ publications: [{ id: "course_material", revision: 3 }] });
    const restoredSources = await worker.fetch(await call(`${path}/sources`), h.env, {} as ExecutionContext);
    await expect(restoredSources.json()).resolves.toEqual({ publication_id: "course_material", revision: 3, document_ids: [] });
    const restoredSearch = await worker.fetch(await call("/internal/spaces/space-a/kb/projects/project-a/external-search",
      { publication_id: "course_material", publication_revision: 3, query: "approved fact" }, "POST"), h.env, {} as ExecutionContext);
    expect(restoredSearch.status).toBe(200);
    await expect(restoredSearch.json()).resolves.toMatchObject({ data: [] });
    expect(h.vectorQuery).not.toHaveBeenCalled();

    const republished = await worker.fetch(await call(path, { name: "Course material", document_ids: ["doc-b"], expected_revision: 3 }), h.env, {} as ExecutionContext);
    expect(republished.status).toBe(200);
    await expect(republished.json()).resolves.toMatchObject({ revision: 4, document_ids: ["doc-b"] });
    expect(h.db.db.prepare("SELECT action,from_revision,to_revision FROM kb_external_publication_events ORDER BY to_revision").all())
      .toEqual([{ action: "published", from_revision: 0, to_revision: 1 },
        { action: "archived", from_revision: 1, to_revision: 2 },
        { action: "restored_as_draft", from_revision: 2, to_revision: 3 },
        { action: "updated", from_revision: 3, to_revision: 4 }]);
    expect(h.db.db.prepare("SELECT document_id,publication_revision FROM kb_external_publication_documents").all())
      .toEqual([{ document_id: "doc-b", publication_revision: 4 }]);
    const republishedSources = await worker.fetch(await call(`${path}/sources`), h.env, {} as ExecutionContext);
    await expect(republishedSources.json()).resolves.toEqual({ publication_id: "course_material", revision: 4, document_ids: ["doc-b"] });
  });

  it("requires owner authority and current revision for archive transitions", async () => {
    const h = harness();
    const path = "/spaces/space-a/kb/projects/project-a/external-publications/course_material";
    const created = await worker.fetch(await call(path, { name: "Course material", document_ids: ["doc-a"], expected_revision: 0 }), h.env, {} as ExecutionContext);
    expect(created.status).toBe(200);
    const denied = await worker.fetch(await call(`${path}/archive`, { expected_revision: 1, archived: true }, "PUT", "member"), h.env, {} as ExecutionContext);
    expect(denied.status).toBe(403);
    const archived = await worker.fetch(await call(`${path}/archive`, { expected_revision: 1, archived: true }, "PUT"), h.env, {} as ExecutionContext);
    expect(archived.status).toBe(200);
    const stale = await worker.fetch(await call(`${path}/archive`, { expected_revision: 1, archived: false }, "PUT"), h.env, {} as ExecutionContext);
    expect(stale.status).toBe(409);
    const status = await worker.fetch(await call(`${path}/archive`, { expected_revision: 2, archived: "yes" }, "PUT"), h.env, {} as ExecutionContext);
    expect(status.status).toBe(400);
    const current = await worker.fetch(await call("/spaces/space-a/kb/projects/project-a/external-publications"), h.env, {} as ExecutionContext);
    await expect(current.json()).resolves.toMatchObject({ publications: [{ archived: true, revision: 2, document_count: 0 }] });
  });
});
