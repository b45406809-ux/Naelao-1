Warning: truncated output (original token count: 3067)
Total output lines: 239

import { describe, expect, it, vi } from "vitest";
import { deleteKvPrefix, erasureAuditId, eraseSpaceD1Records, eraseSpaceKnowledgeResources, eraseSpaceR2Resources, eraseSpacesInSteps, SPACE_ERASURE_TABLES, validateBlueprintExportKey } from "./erasure-cleanup.js";

describe("erasure workflow audit idempotency", () => {
  it("uses stable request-scoped identifiers for retried workflow audit steps", () => {
    expect(erasureAuditId("requested", "request-a")).toBe("erasure-requested-request-a");
    expect(erasureAuditId("completed", "request-a")).toBe("erasure-completed-request-a");
    expect(erasureAuditId("completed", "request-a")).toBe(erasureAuditId("completed", "request-a"));
    expect(() => erasureAuditId("completed", "../other")).toThrow(/identifier/);
  });
});

describe("space erasure workflow checkpointing", () => {
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
    expect(c…1067 tokens truncated…Throw(/chunk count/);
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
    expect(statements).toHaveLength(SPACE_ERASURE_TABLES.length);
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
