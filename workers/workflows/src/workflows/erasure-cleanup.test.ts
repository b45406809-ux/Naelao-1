import { describe, expect, it, vi } from "vitest";
import { eraseSpaceD1Records, eraseSpaceKnowledgeResources } from "./erasure-cleanup.js";

describe("space knowledge resource erasure", () => {
  it("uses project-scoped keys, drains all pages, and bounds object/vector batches", async () => {
    const pages = Array.from({ length: 2 }, (_, page) => ({
      objects: Array.from({ length: page === 0 ? 105 : 2 }, (_, i) => ({ key: `page-${page}-object-${i}` })),
      truncated: page === 0,
      ...(page === 0 ? { cursor: "cursor-1" } : {}),
    }));
    const list = vi.fn(async ({ prefix }: { prefix: string }) => prefix.includes("doc-a")
      ? pages.shift()!
      : { objects: [], truncated: false });
    const deleteObject = vi.fn(async () => undefined);
    const deleteVectors = vi.fn(async (_ids: string[]) => undefined);

    await eraseSpaceKnowledgeResources("space-a", [{ id: "doc-a", project_id: "project-a", chunk_count: 205 }],
      { list, delete: deleteObject } as never, { deleteByIds: deleteVectors } as never);

    expect(list).toHaveBeenNthCalledWith(1, { prefix: "kb/space-a/project-a/doc-a/", limit: 1000 });
    expect(list).toHaveBeenNthCalledWith(2, { prefix: "kb/space-a/project-a/doc-a/", cursor: "cursor-1", limit: 1000 });
    expect(list).toHaveBeenNthCalledWith(3, { prefix: "kb/space-a/", limit: 1000 });
    expect(list).toHaveBeenNthCalledWith(4, { prefix: "autorag/space-a/", limit: 1000 });
    expect(deleteObject).toHaveBeenCalledTimes(108);
    expect(deleteVectors.mock.calls.map(([ids]) => ids.length)).toEqual([100, 100, 5]);
  });

  it("uses the space-level key namespace when a document has no project", async () => {
    const list = vi.fn(async () => ({ objects: [], truncated: false }));
    await eraseSpaceKnowledgeResources("space-a", [{ id: "doc-a", project_id: null, chunk_count: null }],
      { list, delete: vi.fn() } as never, { deleteByIds: vi.fn() } as never);
    expect(list).toHaveBeenNthCalledWith(1, { prefix: "kb/space-a/_space/doc-a/", limit: 1000 });
  });

  it.each([
    { truncated: true, cursor: undefined },
    { truncated: true, cursor: "same" },
  ])("fails closed for incomplete or repeated pagination cursors", async ({ truncated, cursor }) => {
    const list = vi.fn(async () => ({ objects: [], truncated, ...(cursor ? { cursor } : {}) }));
    const bucket = { list, delete: vi.fn() };
    if (cursor) list.mockResolvedValueOnce({ objects: [], truncated: true, cursor: "same" }).mockResolvedValueOnce({ objects: [], truncated: true, cursor: "same" });
    await expect(eraseSpaceKnowledgeResources("space-a", [], bucket as never, { deleteByIds: vi.fn() } as never))
      .rejects.toThrow(/cursor/);
  });

  it("rejects corrupt vector counts before deleting external resources", async () => {
    const list = vi.fn();
    const deleteObject = vi.fn();
    await expect(eraseSpaceKnowledgeResources("space-a", [{ id: "doc-a", project_id: null, chunk_count: 12_001 }],
      { list, delete: deleteObject } as never, { deleteByIds: vi.fn() } as never)).rejects.toThrow(/chunk count/);
    expect(list).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });
});

describe("space D1 erasure", () => {
  it("removes chunk records, session shadows, and parent thread summaries atomically", async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return { bind: () => ({ sql }) };
      },
      batch: vi.fn(async () => []),
    };
    await eraseSpaceD1Records(db as never, "space-a");
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(statements).toEqual([
      "DELETE FROM kb_chunks WHERE space_id = ?",
      "DELETE FROM kb_documents WHERE space_id = ?",
      "DELETE FROM active_sessions WHERE space_id = ?",
      "DELETE FROM thread_sessions WHERE space_id = ?",
      "DELETE FROM threads WHERE space_id = ?",
    ]);
  });
});
