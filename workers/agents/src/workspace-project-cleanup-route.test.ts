import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app } from "./index.js";
import { sha256Hex } from "./workspace/workspace-contract.js";
import { workspaceErasureBackupKey } from "./workspace/erasure-backup.js";

describe("per-project workspace cleanup route", () => {
  it("holds the project mutation lease while tombstoning and deleting one retryable prefix page", async () => {
    const secret = "project-cleanup-route-secret";
    const lockEvents: Array<{ path: string; body: Record<string, unknown> }> = [];
    const coordinatorRequests: Array<{ path: string; body: unknown }> = [];
    const keys = new Set(["spaces/space-a/projects/project-a/workspace/branches/worker-a/file.txt"]);
    const concurrency = { fetch: vi.fn(async (request: Request) => {
      const body = await request.json() as Record<string, unknown>;
      const path = new URL(request.url).pathname;
      lockEvents.push({ path, body });
      return path.endsWith("/acquire") ? Response.json({ acquired: true, fencingToken: 7 }) : Response.json({ ok: true });
    }) };
    const bucket = {
      list: vi.fn(async ({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) => {
        const after = cursor ? atob(cursor) : "";
        const selected = [...keys].filter(key => key.startsWith(prefix) && key > after).sort().slice(0, limit);
        const truncated = [...keys].some(key => key.startsWith(prefix) && key > (selected.at(-1) ?? after));
        return { objects: selected.map(key => ({ key })), truncated, ...(truncated && selected.length ? { cursor: btoa(selected.at(-1)!) } : {}) };
      }),
      delete: vi.fn(async (items: string | string[]) => { for (const key of Array.isArray(items) ? items : [items]) keys.delete(key); }),
    };
    const workspaceCoordinator = { fetch: vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      coordinatorRequests.push({ path, body: await request.json() });
      return path === "/v1/erase/admission" ? Response.json({ admitted: true }) : Response.json({ erased: true });
    }) };
    let tombstone: Record<string, unknown> | null = null;
    let exportRecord: Record<string, unknown> | null = null;
    const database = {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...next: unknown[]) { values = next; return statement; },
          async first() {
            if (sql.includes("FROM workspace_erasure_backup_exports")) return exportRecord;
            if (sql.includes("FROM workspace_erasure_tombstones")) return tombstone;
            if (sql.includes("SELECT id FROM sandbox_filesystems")) return null;
            if (sql.includes("FROM sandbox_provider_deletion_operations")) return { pending: 0, unresolved: 0 };
            return null;
          },
          async all() { return { results: [] }; },
          async run() {
            if (sql.includes("INSERT OR IGNORE INTO workspace_erasure_tombstones") && !tombstone) {
              tombstone = { tenant_id: values[0], space_id: values[1], project_id: values[2], tombstone_id: values[3], jurisdiction: values[4],
                requested_at: values[5], status: "pending", cleanup_phase: "legacy", cleanup_cursor: null, bridge_cleanup_cursor: null, cleanup_page: 0 };
            }
            if (sql.includes("INSERT OR IGNORE INTO workspace_erasure_backup_exports")) {
              exportRecord = { backup_key: values[5], receipt_sha256: values[6] };
            }
            if (sql.includes("UPDATE workspace_erasure_tombstones")) {
              tombstone = { ...tombstone, cleanup_phase: values[0], cleanup_cursor: values[1], bridge_cleanup_cursor: values[2],
                cleanup_page: values[3], status: values[4] };
            }
            return { success: true, meta: { changes: 1 } };
          },
        };
        return statement;
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) { for (const statement of statements) await statement.run(); return []; },
    };
    let ledger: string | null = null;
    const backups = new Map<string, string>();
    const backupBucket = {
      put: vi.fn(async (key: string, value: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }) => {
        if (options?.onlyIf?.etagDoesNotMatch === "*" && backups.has(key)) return null;
        backups.set(key, value); return { key };
      }),
      get: vi.fn(async (key: string) => { const value = backups.get(key); return value ? { async json() { return JSON.parse(value); } } : null; }),
    };
    const env = {
      PLATFORM_SECRET: secret,
      PLATFORM_DB: database,
      CONCURRENCY_DO: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => concurrency) },
      WORKSPACE_COORDINATOR: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => workspaceCoordinator) },
      SCRIPTS_R2: { ...bucket,
        put: vi.fn(async (key: string, value: string) => { if (key.startsWith("workspace-erasure-ledger/")) ledger ??= value; return { key }; }),
        get: vi.fn(async (key: string) => key.startsWith("workspace-erasure-ledger/") && ledger ? { async json() { return JSON.parse(ledger!); } } : null),
      },
      WORKSPACE_ERASURE_BACKUP_R2: backupBucket,
    } as never;
    const token = await mintInternalToken(secret, "tenant-a");
    const deleteRequest = (cursor?: string) => app.request("/internal/workspaces/delete-project", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
      body: JSON.stringify({ scope: { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" }, confirm: true,
        ...(cursor ? { cursor } : {}) }),
    }, env);

    const first = await deleteRequest();
    expect(first.status).toBe(200);
    const firstResult = await first.json() as { hasMore: boolean; nextCursor: string };
    expect(firstResult.hasMore).toBe(true);
    const response = await deleteRequest(firstResult.nextCursor);
    expect(response.status).toBe(200);
    const secondResult = await response.json() as { hasMore: boolean; nextCursor?: string };
    expect(secondResult.hasMore).toBe(true);
    const thirdResponse = await deleteRequest(secondResult.nextCursor);
    expect(thirdResponse.status).toBe(200);
    const thirdResult = await thirdResponse.json() as { hasMore: boolean; nextCursor?: string };
    expect(thirdResult.hasMore).toBe(true);
    const finalResponse = await deleteRequest(thirdResult.nextCursor);
    expect(finalResponse.status).toBe(200);
    expect(await finalResponse.json()).toMatchObject({ erased: true, hasMore: false, providerConnectionsDeleted: false });
    expect(lockEvents.map(event => event.path)).toEqual(["/locks/acquire", "/locks/release", "/locks/acquire", "/locks/release",
      "/locks/acquire", "/locks/release", "/locks/acquire", "/locks/release"]);
    expect(lockEvents[0]!.body).toMatchObject({ key: "lock:space-a:project-a:workspace-migration-barrier", ttlMs: 600_000 });
    expect(coordinatorRequests).toHaveLength(8);
    expect(coordinatorRequests.filter(request => request.path === "/v1/erase/admission")).toHaveLength(4);
    expect(coordinatorRequests.filter(request => request.path === "/v1/erase")).toHaveLength(4);
    expect(bucket.delete).toHaveBeenCalledWith(["spaces/space-a/projects/project-a/workspace/branches/worker-a/file.txt"]);
    expect(backupBucket.put).toHaveBeenCalledTimes(4);
    expect(backups.size).toBe(1);
    expect([...keys]).toEqual([]);
  });

  it("fails closed when the project mutation lease is already held", async () => {
    const secret = "project-cleanup-route-secret";
    const concurrency = { fetch: vi.fn(async () => Response.json({ acquired: false })) };
    const workspaceCoordinator = { fetch: vi.fn() };
    const bucket = { list: vi.fn(), delete: vi.fn() };
    const env = { PLATFORM_SECRET: secret, CONCURRENCY_DO: { idFromName: () => "barrier", get: () => concurrency },
      WORKSPACE_COORDINATOR: { idFromName: () => "workspace", get: () => workspaceCoordinator }, SCRIPTS_R2: bucket } as never;
    const response = await app.request("/internal/workspaces/delete-project", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a",
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
      body: JSON.stringify({ scope: { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" }, confirm: true }),
    }, env);
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ error_code: "workspace_migration_barrier_busy" });
    expect(workspaceCoordinator.fetch).not.toHaveBeenCalled();
    expect(bucket.list).not.toHaveBeenCalled();
  });

  it("restores a tenant-scoped tombstone page from the independent backup bucket", async () => {
    const secret = "erasure-backup-route-secret";
    const scope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "restored-project", jurisdiction: "global" as const };
    const receipt = { tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: scope.projectId, jurisdiction: scope.jurisdiction,
      tombstone_id: `wser_${await sha256Hex(new TextEncoder().encode(`${scope.tenantId}\0${scope.spaceId}\0${scope.projectId}`))}`,
      requested_at: "2026-11-11T00:00:00.000Z" };
    const receiptSha256 = await sha256Hex(new TextEncoder().encode(JSON.stringify(receipt)));
    const key = workspaceErasureBackupKey(receipt);
    let tombstone: Record<string, unknown> | null = null;
    const database = {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...next: unknown[]) { values = next; return statement; },
          async first() {
            if (sql.includes("FROM workspace_erasure_tombstones")) return tombstone;
            return null;
          },
          async all() { return { results: [] }; },
          async run() {
            if (sql.includes("INSERT OR IGNORE INTO workspace_erasure_tombstones") && !tombstone) {
              tombstone = { tenant_id: values[0], space_id: values[1], project_id: values[2], tombstone_id: values[3],
                jurisdiction: values[4], status: "pending" };
            }
            return { success: true, meta: { changes: 1 } };
          },
        };
        return statement;
      },
    };
    let primaryReceipt: string | null = null;
    const primaryLedger = {
      put: vi.fn(async (_key: string, value: string) => { primaryReceipt = value; return { key: _key }; }),
      get: vi.fn(async () => primaryReceipt ? { async json() { return JSON.parse(primaryReceipt!); } } : null),
    };
    const backup = {
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({ objects: [{ key }].filter(object => object.key.startsWith(prefix)), truncated: false })),
      get: vi.fn(async (objectKey: string) => objectKey === key ? { async json() { return { schema_version: 1, receipt, receipt_sha256: receiptSha256 }; } } : null),
    };
    const token = await mintInternalToken(secret, scope.tenantId);
    const response = await app.request("/internal/workspaces/erasure/restore-backup", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId, "x-naelao-internal-token": token },
      body: JSON.stringify({ jurisdiction: "global", confirm: true }),
    }, { PLATFORM_SECRET: secret, PLATFORM_DB: database, SCRIPTS_R2: primaryLedger, WORKSPACE_ERASURE_BACKUP_R2: backup } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ receiptsReplayed: 1, tombstonesCreated: 1, hasMore: false, cleanupResumesOnSchedule: true });
    expect(tombstone).toMatchObject({ tombstone_id: receipt.tombstone_id, status: "pending" });
    expect(JSON.parse(primaryReceipt!)).toMatchObject({ tombstone_id: receipt.tombstone_id });
  });
});
