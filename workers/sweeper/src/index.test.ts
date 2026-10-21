import { describe, expect, it, vi } from "vitest";
import {
  cleanDeletedSpaces,
  cleanExpiredApiKeys,
  cleanExpiredIdempotencyKeys,
  cleanFailedDocs,
  cleanOrphanedKnowledgeChunks,
} from "./index.js";

describe("idempotency expiry cleanup", () => {
  it("compares ISO timestamps as dates and reports deleted rows", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 12 } });
    const prepare = vi.fn().mockReturnValue({ run });
    const deleted = await cleanExpiredIdempotencyKeys({ prepare } as never);
    expect(prepare).toHaveBeenCalledWith(
      `DELETE FROM idempotency_keys WHERE rowid IN (
       SELECT rowid FROM idempotency_keys WHERE julianday(expires_at) < julianday('now') LIMIT 1000
     )`
    );
    expect(deleted).toBe(12);
  });
});

describe("API key expiry cleanup", () => {
  it("compares ISO timestamps as dates", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 3 } });
    const prepare = vi.fn().mockReturnValue({ run });
    await expect(cleanExpiredApiKeys({ prepare } as never)).resolves.toBe(3);
    expect(prepare).toHaveBeenCalledWith(
      `DELETE FROM api_keys WHERE rowid IN (
       SELECT rowid FROM api_keys
       WHERE expires_at IS NOT NULL AND julianday(expires_at) < julianday('now') LIMIT 1000
     )`
    );
  });
});

describe("bounded knowledge cleanup", () => {
  function failedDocHarness(chunkCount: number | null = 201) {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const select = vi.fn().mockReturnValue({
      all: vi.fn().mockResolvedValue({ results: [{
        id: "doc-a", space_id: "space-a", project_id: "project-a", chunk_count: chunkCount,
      }] }),
    });
    const deletion = vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ run }) });
    const prepare = vi.fn((sql: string) => sql.startsWith("SELECT") ? select() : deletion());
    const db = { prepare };
    const list = vi.fn().mockResolvedValue({
      objects: [{ key: "kb/space-a/project-a/doc-a/chunk_0.json" }],
      truncated: false,
    });
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const vectorsDelete = vi.fn().mockResolvedValue(undefined);
    return {
      db,
      select,
      deletion,
      list,
      deleteObject,
      vectorsDelete,
      bucket: { list, delete: deleteObject },
      vectors: { deleteByIds: vectorsDelete },
    };
  }

  it("deletes the project-scoped R2 keys and vector IDs in bounded batches", async () => {
    const h = failedDocHarness(201);
    await expect(cleanFailedDocs(h.db as never, h.bucket as never, h.vectors as never)).resolves.toBe(1);
    expect(h.list).toHaveBeenCalledWith({ prefix: "kb/space-a/project-a/doc-a/", limit: 1000 });
    expect(h.deleteObject).toHaveBeenCalledWith("autorag/space-a/project-a/doc-a.md");
    expect(h.vectorsDelete.mock.calls.map(([ids]) => ids.length)).toEqual([100, 100, 1]);
    expect(h.db.prepare).toHaveBeenCalledWith(
      "DELETE FROM kb_chunks WHERE document_id = ? AND tenant_id = ? AND space_id = ? AND project_id = ?"
    );
    expect(h.db.prepare).toHaveBeenCalledWith("DELETE FROM kb_documents WHERE id = ?");
  });

  it("keeps the document record when the stored chunk count exceeds its safe ceiling", async () => {
    const h = failedDocHarness(12_001);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(cleanFailedDocs(h.db as never, h.bucket as never, h.vectors as never)).resolves.toBe(0);
    expect(h.vectorsDelete).not.toHaveBeenCalled();
    expect(h.deletion).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves documents with more than one pass of R2 pages for the next sweep", async () => {
    const h = failedDocHarness(1);
    h.list.mockImplementation(async ({ cursor }: { cursor?: string }) => ({
      objects: [{ key: `kb/space-a/project-a/doc-a/${cursor ?? "first"}` }],
      truncated: true,
      cursor: cursor === undefined ? "cursor-1" : `cursor-${Number(cursor.split("-")[1]) + 1}`,
    }));
    const deleted = await cleanFailedDocs(h.db as never, h.bucket as never, h.vectors as never);
    expect(deleted).toBe(0);
    expect(h.list).toHaveBeenCalledTimes(10);
    expect(h.deletion).not.toHaveBeenCalled();
    expect(h.vectorsDelete).not.toHaveBeenCalled();
  });

  it("uses the project prefix when cascading a deleted space", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const statements = vi.fn((sql: string) => {
      if (sql.includes("FROM spaces s")) {
        return { all: vi.fn().mockResolvedValue({ results: [{ space_id: "space-a" }] }) };
      }
      if (sql.includes("SELECT d.id, d.tenant_id, d.project_id")) {
        return { bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [{
          id: "doc-a", project_id: "project-a", chunk_count: 1,
        }] }) }) };
      }
      return { bind: vi.fn().mockReturnValue({ run }) };
    });
    const db = { prepare: statements };
    const list = vi.fn().mockResolvedValue({ objects: [], truncated: false });
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const vectorsDelete = vi.fn().mockResolvedValue(undefined);
    await expect(cleanDeletedSpaces(
      db as never,
      { list, delete: deleteObject } as never,
      { deleteByIds: vectorsDelete } as never
    )).resolves.toBe(1);
    expect(list).toHaveBeenCalledWith({ prefix: "kb/space-a/project-a/doc-a/", limit: 1000 });
    expect(deleteObject).toHaveBeenCalledWith("autorag/space-a/project-a/doc-a.md");
    expect(vectorsDelete).toHaveBeenCalledWith(["doc-a_chunk_0"]);
    expect(statements).toHaveBeenCalledWith(
      "DELETE FROM kb_chunks WHERE document_id = ? AND tenant_id = ? AND space_id = ? AND project_id = ?"
    );
    expect(statements).toHaveBeenCalledWith("DELETE FROM kb_chunks WHERE space_id = ?");
    expect(statements).toHaveBeenCalledWith("UPDATE threads SET session_count = 0 WHERE space_id = ?");
  });

  it("cleans orphaned D1 chunks together with their R2 objects and vectors", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 2 } });
    const prepare = vi.fn((sql: string) => sql.startsWith("SELECT")
      ? { all: vi.fn().mockResolvedValue({ results: [{
          id: "orphan-doc", tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a", chunk_count: 2,
        }] }) }
      : { bind: vi.fn().mockReturnValue({ run }) });
    const list = vi.fn().mockResolvedValue({ objects: [], truncated: false });
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const deleteVectors = vi.fn().mockResolvedValue(undefined);
    await expect(cleanOrphanedKnowledgeChunks(
      { prepare } as never,
      { list, delete: deleteObject } as never,
      { deleteByIds: deleteVectors } as never
    )).resolves.toBe(2);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("GROUP BY kc.document_id"));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("WHERE d.id IS NULL"));
    expect(list).toHaveBeenCalledWith({ prefix: "kb/space-a/project-a/orphan-doc/", limit: 1000 });
    expect(deleteVectors).toHaveBeenCalledWith(["orphan-doc_chunk_0", "orphan-doc_chunk_1"]);
    expect(prepare).toHaveBeenCalledWith(
      "DELETE FROM kb_chunks WHERE document_id = ? AND tenant_id = ? AND space_id = ? AND project_id = ?"
    );
  });

  it("does not mark a space clean while an R2 prefix still has pages", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const prepare = vi.fn((sql: string) => {
      if (sql.includes("FROM spaces s")) {
        return { all: vi.fn().mockResolvedValue({ results: [{ space_id: "space-a" }] }) };
      }
      if (sql.includes("SELECT id, tenant_id, project_id")) {
        return { bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [{
          id: "doc-a", tenant_id: "tenant-a", project_id: null, chunk_count: 1,
        }] }) }) };
      }
      return { bind: vi.fn().mockReturnValue({ run }) };
    });
    const list = vi.fn(async () => ({ objects: [], truncated: true, cursor: "next-page" }));
    await expect(cleanDeletedSpaces(
      { prepare } as never,
      { list, delete: vi.fn() } as never,
      { deleteByIds: vi.fn() } as never
    )).resolves.toBe(0);
    expect(prepare).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE kb_documents SET status = 'purged'"));
    expect(run).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
