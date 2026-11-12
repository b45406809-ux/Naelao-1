import { describe, expect, it, vi } from "vitest";
import { deleteKvPrefix, erasureAuditId, eraseSpaceD1Records, eraseSpaceDurableState, eraseSpaceKnowledgeResources, eraseSpaceR2Resources, eraseSpacesInSteps, eraseWorkspaceCoordinatorsForSpace, invalidateSpaceKnowledgeCaches, SPACE_ERASURE_TABLES, validateBlueprintExportKey } from "./erasure-cleanup.js";

describe("erasure workflow audit idempotency", () => {
  it("uses stable request-scoped identifiers for retried workflow audit steps", () => {
    expect(erasureAuditId("requested", "request-a")).toBe("erasure-requested-request-a");
    expect(erasureAuditId("completed", "request-a")).toBe("erasure-completed-request-a");
    expect(erasureAuditId("completed", "request-a")).toBe(erasureAuditId("completed", "request-a"));
    expect(() => erasureAuditId("completed", "../other")).toThrow(/identifier/);
  });
});

describe("Space knowledge cache erasure", () => {
  it("uses the tenant-authenticated Knowledge Worker route for suspended Spaces", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/internal/semantic-cache");
      expect(new URL(request.url).searchParams.get("spaceId")).toBe("space-a");
      expect(request.method).toBe("DELETE");
      expect(request.headers.get("x-naelao-tenant-id")).toBe("tenant-a");
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      return Response.json({ invalidated: true, cleanup_pending: true });
    });
    await expect(invalidateSpaceKnowledgeCaches({ tenantId: "tenant-a", spaceId: "space-a", platformSecret: "secret", knowledgeWorker: { fetch } as never }))
      .resolves.toEqual({ cleanupPending: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps whole-Space erasure retryable when cache invalidation is unavailable", async () => {
    const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await expect(invalidateSpaceKnowledgeCaches({ tenantId: "tenant-a", spaceId: "space-a", platformSecret: "secret", knowledgeWorker: { fetch } as never }))
      .rejects.toThrow("Knowledge cache erasure failed with status 503");
  });
});

describe("space erasure workflow checkpointing", () => {
  it("erases one bounded coordinator page and returns its continuation cursor", async () => {
    let enumerationRequest: Request | undefined;
    const spacesWorker = { fetch: vi.fn(async (request: Request) => {
      enumerationRequest = request;
      return Response.json({ projectIds: ["project-a", "project-b"], nextCursor: "project-b", hasMore: true });
    }) } as unknown as Fetcher;
    const erasedScopes: unknown[] = [];
    const agentsWorker = { fetch: vi.fn(async (request: Request) => {
      const body = await request.json() as { scope?: unknown; confirm?: boolean };
      erasedScopes.push(body);
      return Response.json({ erased: true, hasMore: false, providerConnectionsDeleted: false });
    }) } as unknown as Fetcher;
    const result = await eraseWorkspaceCoordinatorsForSpace({ tenantId: "tenant-a", spaceId: "space-a", jurisdiction: "eu", platformSecret: "secret", spacesWorker, agentsWorker, after: "project-0" });
    expect(result).toEqual({ erasedCount: 2, nextCursor: "project-b", hasMore: true });
    expect(enumerationRequest && new URL(enumerationRequest.url).searchParams.get("after")).toBe("project-0");
    expect(erasedScopes).toEqual([
      { scope: { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "eu" }, confirm: true },
      { scope: { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-b", jurisdiction: "eu" }, confirm: true },
    ]);
  });

  it("runs every space in its own stable workflow step across D1 pages", async () => {
    const stepNames: string[] = [];
    const erased: string[] = [];
    const stepResults = new Map<string, unknown>();
    const allSpaces = Array.from({ length: 205 }, (_, index) => `space-${String(index).padStart(3, "0")}`);
    const db = {
      prepare: (_sql: string) => ({
        bind: (_tenantId: string, after: string) => ({
          all: async () => ({ results: allSpaces.filter((id) => id > after).slice(0, 100).map((id) => ({ id })) }),
        }),
      }),
    };

    const step = {
      async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
        stepNames.push(name);
        if (stepResults.has(name)) return stepResults.get(name) as T;
        const result = await callback();
        stepResults.set(name, result);
        return result;
      },
    };
    const processed = await eraseSpacesInSteps(
      db as never,
      "tenant-a",
      step as never,
      async (spaceId) => { erased.push(spaceId); },
    );
    const firstRunSteps = stepNames.length;
    await eraseSpacesInSteps(db as never, "tenant-a", step as never, async (spaceId) => { erased.push(spaceId); });

    expect(processed).toBe(205);
    expect(erased).toHaveLength(205);
    expect(new Set(stepNames.slice(0, firstRunSteps)).size).toBe(firstRunSteps);
    expect(stepNames.slice(0, firstRunSteps).filter((name) => name.startsWith("list-space-page-"))).toEqual([
      "list-space-page-0", "list-space-page-1", "list-space-page-2", "list-space-page-3",
    ]);
    expect(stepNames.slice(0, firstRunSteps).filter((name) => name.startsWith("erase-space-")).slice(0, 3)).toEqual([
      "erase-space-0", "erase-space-1", "erase-space-2",
    ]);
  });

  it("retries the failed space step without replaying completed space cleanup", async () => {
    const allSpaces = Array.from({ length: 105 }, (_, index) => `space-${String(index).padStart(3, "0")}`);
    const db = {
      prepare: (_sql: string) => ({
        bind: (_tenantId: string, after: string) => ({
          all: async () => ({ results: allSpaces.filter((id) => id > after).slice(0, 100).map((id) => ({ id })) }),
        }),
      }),
    };
    const results = new Map<string, unknown>();
    const calls = new Map<string, number>();
    const step = {
      async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
        if (results.has(name)) return results.get(name) as T;
        const value = await callback();
        results.set(name, value);
        return value;
      },
    };
    let failOnce = true;
    const eraseSpace = async (spaceId: string) => {
      calls.set(spaceId, (calls.get(spaceId) ?? 0) + 1);
      if (spaceId === "space-101" && failOnce) {
        failOnce = false;
        throw new Error("temporary storage failure");
      }
    };

    await expect(eraseSpacesInSteps(db as never, "tenant-a", step as never, eraseSpace))
      .rejects.toThrow("temporary storage failure");
    await expect(eraseSpacesInSteps(db as never, "tenant-a", step as never, eraseSpace)).resolves.toBe(105);

    expect(calls.get("space-000")).toBe(1);
    expect(calls.get("space-100")).toBe(1);
    expect(calls.get("space-101")).toBe(2);
    expect(calls.get("space-104")).toBe(1);
  });
});

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
  it("queues provider deletion before FK-safe cleanup and preserves the tombstone/outbox", async () => {
    const statements: string[] = [];
    const batches: string[][] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        let values: unknown[] = [];
        const statement = {
          sql,
          bind: (...next: unknown[]) => { values = next; return statement; },
          all: async () => sql.includes("FROM sandbox_allocations a JOIN sandbox_computers") ? { results: [{
            allocation_id: "alloc-a", connection_id: "connection-a", provider: "agent37", external_id: "instance-a",
            generation: 1, computer_id: "computer-a", tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a",
          }] } : { results: [] },
          run: async () => ({ success: true, meta: { changes: 1 }, values }),
        };
        return statement;
      },
      batch: vi.fn(async (entries: Array<{ sql: string; run(): Promise<unknown> }>) => {
        batches.push(entries.map(entry => entry.sql));
        for (const entry of entries) await entry.run();
        return entries.map(() => ({ success: true, meta: { changes: 1 } }));
      }),
    };
    await eraseSpaceD1Records(db as never, "space-a");
    expect(db.batch).toHaveBeenCalledTimes(2);
    const outboxInsert = statements.findIndex(sql => sql.includes("INSERT OR IGNORE INTO sandbox_provider_deletion_operations"));
    const allocationDelete = statements.findIndex(sql => sql.includes("DELETE FROM sandbox_allocations"));
    expect(outboxInsert).toBeGreaterThanOrEqual(0);
    expect(allocationDelete).toBeGreaterThan(outboxInsert);
    expect(statements[allocationDelete]).toContain("id NOT IN (SELECT allocation_id FROM sandbox_provider_deletion_operations WHERE status NOT IN ('confirmed_deleted','retained'))");
    expect(statements).not.toContain("DELETE FROM sandbox_provider_deletion_operations WHERE space_id = ?");
    expect(statements).not.toContain("DELETE FROM workspace_erasure_tombstones WHERE space_id = ?");
    expect(batches[0]).toContain("UPDATE sandbox_usage_events SET computer_id=NULL,execution_id=NULL,connection_id=NULL WHERE tenant_id IN (SELECT tenant_id FROM sandbox_computers WHERE space_id=?) AND computer_id IN (SELECT id FROM sandbox_computers WHERE space_id=?)");
    expect(SPACE_ERASURE_TABLES).not.toContain("sandbox_filesystems" as never);
    expect(statements).toContain("DELETE FROM space_credentials WHERE space_id = ?");
    expect(statements).toContain("DELETE FROM mcp_servers WHERE space_id = ?");
    expect(statements).toContain("DELETE FROM webhook_subscriptions WHERE space_id = ?");
    expect(SPACE_ERASURE_TABLES).toContain("kb_document_deletion_operations" as never);
    expect(SPACE_ERASURE_TABLES).toContain("kb_document_mutation_leases" as never);
    expect(statements.slice(-SPACE_ERASURE_TABLES.length)).toHaveLength(SPACE_ERASURE_TABLES.length);
    expect(statements).toContain("DELETE FROM fde_graduations WHERE space_id = ?");
    expect(statements).toContain("DELETE FROM llm_token_reservations WHERE space_id = ?");
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
    expect(workspacePrefixes).toEqual(["spaces/space-a/", "workspace-v1/tenant-a/space-a/", "space-archives/tenant-a/space-a/"]);
    expect(deleted).toEqual(["conformance-jobs/tenant-a/export-a.json"]);
  });

  it("tombstones the exact SpaceDO before archive-prefix cleanup and validates replay receipts", async () => {
    const requests: Request[] = [];
    const spacesWorker = { fetch: vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ erased: true, tenant_id: "tenant-a", space_id: "space-a", request_id: "erase-request-a", replayed: true });
    }) } as never;
    await expect(eraseSpaceDurableState({ tenantId: "tenant-a", spaceId: "space-a", requestId: "erase-request-a", platformSecret: "secret", spacesWorker }))
      .resolves.toEqual({ replayed: true });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/internal/tenant/tenant-a/spaces/space-a/data-erasure");
    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.headers.get("x-naelao-tenant-id")).toBe("tenant-a");
    expect(requests[0]!.headers.get("x-naelao-internal-token")).toBeTruthy();
    expect(await requests[0]!.json()).toEqual({ request_id: "erase-request-a" });

    const mismatchedReceipt = { fetch: vi.fn(async () => Response.json({ erased: true, tenant_id: "tenant-b", space_id: "space-a", request_id: "erase-request-a" })) } as never;
    await expect(eraseSpaceDurableState({ tenantId: "tenant-a", spaceId: "space-a", requestId: "erase-request-a", platformSecret: "secret", spacesWorker: mismatchedReceipt }))
      .rejects.toThrow("SpaceDO erasure returned an invalid receipt");
    await expect(eraseSpaceDurableState({ tenantId: "../tenant", spaceId: "space-a", requestId: "erase-request-a", platformSecret: "secret", spacesWorker }))
      .rejects.toThrow("Invalid SpaceDO erasure scope");
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
