import { describe, expect, it, vi } from "vitest";
import { deleteKvPrefix, eraseSpaceD1Records, eraseSpaceKnowledgeResources, eraseSpaceR2Resources, validateBlueprintExportKey } from "./erasure-cleanup.js";

describe("KV erasure pagination", () => {
  it("deletes every page and returns the number of deleted keys", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ keys: [{ name: "org-a:one" }], list_complete: false, cursor: "next" })
      .mockResolvedValueOnce({ keys: [{ name: "org-a:two" }], list_complete: true });
    const remove = vi.fn(async (_name: string) => undefined);
    await expect(deleteKvPrefix({ list, delete: remove } as never, "org-a:")).resolves.toBe(2);
    expect(list).toHaveBeenNthCalledWith(1, { prefix: "org-a:" });
    expect(list).toHaveBeenNthCalledWith(2, { prefix: "org-a:", cursor: "next" });
    expect(remove.mock.calls.map(([key]) => key)).toEqual(["org-a:one", "org-a:two"]);
  });

  it.each([undefined, "repeated"])("fails closed for a missing or repeated cursor (%s)", async (cursor) => {
    const list = vi.fn()
      .mockResolvedValueOnce({ keys: [], list_complete: false, ...(cursor ? { cursor } : {}) })
      .mockResolvedValueOnce({ keys: [], list_complete: false, cursor: "repeated" });
    await expect(deleteKvPrefix({ list, delete: vi.fn() } as never, "org-a:")).rejects.toThrow(/cursor/);
    expect(list).toHaveBeenCalledTimes(cursor ? 2 : 1);
  });
});

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
    expect(statements.slice(0, 5)).toEqual([
      "DELETE FROM active_sessions WHERE space_id = ?",
      "DELETE FROM thread_sessions WHERE space_id = ?",
      "DELETE FROM threads WHERE space_id = ?",
      "DELETE FROM kb_chunks WHERE space_id = ?",
      "DELETE FROM kb_documents WHERE space_id = ?",
    ]);
    expect(statements).toContain("DELETE FROM space_credentials WHERE space_id = ?");
    expect(statements).toContain("DELETE FROM mcp_servers WHERE space_id = ?");
    expect(statements).toContain("DELETE FROM webhook_subscriptions WHERE space_id = ?");
    expect(statements).toHaveLength(57);
    expect(statements).toContain("DELETE FROM fde_graduations WHERE space_id = ?");
    expect(statements).toContain("DELETE FROM llm_token_reservations WHERE space_id = ?");
    expect(statements).toContain("DELETE FROM launchpad_products WHERE space_id = ?");
    expect(statements).toContain("DELETE FROM workflow_budget_reservations WHERE space_id = ?");
  });
});

describe("space R2 erasure", () => {
  it("checks each export object key against its tenant and record ID", () => {
    expect(validateBlueprintExportKey("tenant-a", "export-a", "conformance-jobs/tenant-a/export-a.json"))
      .toBe("conformance-jobs/tenant-a/export-a.json");
    expect(() => validateBlueprintExportKey("tenant-a", "export-a", "conformance-jobs/tenant-a/other-space-export.json"))
      .toThrow(/does not match/);
    expect(() => validateBlueprintExportKey("tenant-a", "../other", "conformance-jobs/tenant-a/../other.json"))
      .toThrow(/identifier/);
  });

  it("deletes only the selected tenant/space artifact and workspace prefixes plus exact exports", async () => {
    const artifactPrefixes: string[] = [];
    const repositoryPrefixes: string[] = [];
    const workspacePrefixes: string[] = [];
    const deleted: string[] = [];
    const bucket = (prefixes: string[]) => ({
      async list(options: { prefix: string }) { prefixes.push(options.prefix); return { objects: [], truncated: false }; },
      async delete(keys: string | string[]) { deleted.push(...(Array.isArray(keys) ? keys : [keys])); },
    });

    await eraseSpaceR2Resources("tenant-a", "space-a", bucket(artifactPrefixes) as never,
      bucket(repositoryPrefixes) as never, bucket(workspacePrefixes) as never,
      ["conformance-jobs/tenant-a/export-a.json"]);

    expect(artifactPrefixes).toEqual(["tenant-a/space-a/"]);
    expect(repositoryPrefixes).toEqual(["repositories/tenant-a/space-a/"]);
    expect(workspacePrefixes).toEqual(["spaces/space-a/"]);
    expect(deleted).toEqual(["conformance-jobs/tenant-a/export-a.json"]);
  });

  it("bounds exact export deletion batches and rejects keys outside the tenant namespace", async () => {
    const deleteBatchSizes: number[] = [];
    const bucket = () => ({
      async list() { return { objects: [], truncated: false }; },
      async delete(keys: string | string[]) { deleteBatchSizes.push(Array.isArray(keys) ? keys.length : 1); },
    });
    const keys = Array.from({ length: 205 }, (_, index) => `conformance-jobs/tenant-a/export-${index}.json`);
    await eraseSpaceR2Resources("tenant-a", "space-a", bucket() as never, bucket() as never, bucket() as never, keys);
    expect(deleteBatchSizes).toEqual([100, 100, 5]);
    await expect(eraseSpaceR2Resources("tenant-a", "space-a", bucket() as never, bucket() as never, bucket() as never,
      ["conformance-jobs/tenant-b/export.json"])).rejects.toThrow(/Invalid tenant-scoped/);
  });
});
