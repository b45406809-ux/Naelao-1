import { describe, expect, it } from "vitest";
import type { WorkspaceErasureLedgerReceipt } from "./phase6-erasure.js";
import { exportPendingWorkspaceErasureReceipts, exportWorkspaceErasureReceipt, replayWorkspaceErasureBackupPage, workspaceErasureBackupKey } from "./erasure-backup.js";
import { sha256Hex } from "./workspace-contract.js";

const globalScope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" as const };

async function receipt(scope = globalScope): Promise<WorkspaceErasureLedgerReceipt> {
  return {
    tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: scope.projectId, jurisdiction: scope.jurisdiction,
    tombstone_id: `wser_${await sha256Hex(new TextEncoder().encode(`${scope.tenantId}\0${scope.spaceId}\0${scope.projectId}`))}`,
    requested_at: "2026-11-11T00:00:00.000Z",
  };
}

class ErasureDb {
  tombstones: WorkspaceErasureLedgerReceipt[] = [];
  exports = new Map<string, { backup_key: string; receipt_sha256: string }>();

  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...next: unknown[]) => { values = next; return statement; },
      first: async <T>() => {
        if (sql.includes("FROM workspace_erasure_backup_exports")) return (this.exports.get(String(values[0])) ?? null) as T | null;
        if (sql.includes("FROM workspace_erasure_tombstones")) return (this.tombstones.find(row => row.tenant_id === values[0] && row.space_id === values[1] && row.project_id === values[2]) ?? null) as T | null;
        return null;
      },
      all: async <T>() => ({ results: (sql.includes("FROM workspace_erasure_tombstones t")
        ? this.tombstones.filter(row => !this.exports.has(row.tombstone_id)).slice(0, Number(values[0]))
        : []) as T[] }),
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO workspace_erasure_tombstones") &&
            !this.tombstones.some(row => row.tenant_id === values[0] && row.space_id === values[1] && row.project_id === values[2])) {
          this.tombstones.push({ tenant_id: String(values[0]), space_id: String(values[1]), project_id: String(values[2]),
            tombstone_id: String(values[3]), jurisdiction: values[4] as "global" | "eu", requested_at: String(values[5]) });
        }
        if (sql.includes("INSERT OR IGNORE INTO workspace_erasure_backup_exports")) {
          const [id, , , , , key, hash] = values;
          if (!this.exports.has(String(id))) this.exports.set(String(id), { backup_key: String(key), receipt_sha256: String(hash) });
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  }
}

function bucket() {
  const objects = new Map<string, string>();
  let loseNextPutResponse = false;
  return {
    objects,
    loseNextPutResponse() { loseNextPutResponse = true; },
    async put(key: string, value: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }) {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      objects.set(key, value);
      if (loseNextPutResponse) { loseNextPutResponse = false; throw new Error("response_lost_after_commit"); }
      return { key };
    },
    async get(key: string) {
      const value = objects.get(key);
      return value === undefined ? null : { async json<T>() { return JSON.parse(value) as T; } };
    },
    async list({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) {
      const after = cursor ? atob(cursor) : "";
      const matching = [...objects.keys()].filter(key => key.startsWith(prefix) && key > after).sort();
      const selected = matching.slice(0, limit);
      const truncated = matching.length > selected.length;
      return { objects: selected.map(key => ({ key })), truncated, ...(truncated ? { cursor: btoa(selected.at(-1)!) } : {}) };
    },
  };
}

describe("independent workspace erasure receipt backup", () => {
  it("exports an immutable receipt and recovers a committed PUT whose response was lost", async () => {
    const db = new ErasureDb();
    const ledger = await receipt();
    db.tombstones = [ledger];
    const backup = bucket();
    backup.loseNextPutResponse();
    expect(await exportWorkspaceErasureReceipt(db as never, { WORKSPACE_ERASURE_BACKUP_R2: backup as never }, globalScope)).toBe(true);
    expect(backup.objects.size).toBe(1);
    expect(db.exports.get(ledger.tombstone_id)).toMatchObject({ backup_key: workspaceErasureBackupKey(ledger) });
    expect(await exportWorkspaceErasureReceipt(db as never, { WORKSPACE_ERASURE_BACKUP_R2: backup as never }, globalScope)).toBe(true);
    expect(backup.objects.size).toBe(1);
  });

  it("keeps EU exports pending when the separate regional bucket is not configured", async () => {
    const db = new ErasureDb();
    const eu = await receipt({ ...globalScope, jurisdiction: "eu" });
    db.tombstones = [eu];
    await expect(exportWorkspaceErasureReceipt(db as never, { WORKSPACE_ERASURE_BACKUP_R2: bucket() as never }, { ...globalScope, jurisdiction: "eu" }))
      .resolves.toBe(false);
    await expect(exportPendingWorkspaceErasureReceipts(db as never, { WORKSPACE_ERASURE_BACKUP_R2: bucket() as never }))
      .resolves.toEqual({ exported: 0, pending: 1, failed: 0 });
  });

  it("replays a tenant-scoped backup page idempotently after primary state restore", async () => {
    const receipts = await Promise.all([
      receipt(),
      receipt({ ...globalScope, projectId: "project-b" }),
    ]);
    const backup = bucket();
    const writer = new ErasureDb(); writer.tombstones = receipts;
    for (const entry of receipts) {
      await exportWorkspaceErasureReceipt(writer as never, { WORKSPACE_ERASURE_BACKUP_R2: backup as never }, {
        tenantId: entry.tenant_id, spaceId: entry.space_id, projectId: entry.project_id, jurisdiction: entry.jurisdiction,
      });
    }
    const primaryLedger = bucket();
    const db = new ErasureDb();
    const first = await replayWorkspaceErasureBackupPage(db as never, primaryLedger as never,
      { WORKSPACE_ERASURE_BACKUP_R2: backup as never }, { tenantId: globalScope.tenantId, jurisdiction: "global", limit: 1 });
    expect(first).toMatchObject({ receiptsReplayed: 1, tombstonesCreated: 1, hasMore: true });
    expect(db.tombstones).toHaveLength(1);
    const second = await replayWorkspaceErasureBackupPage(db as never, primaryLedger as never,
      { WORKSPACE_ERASURE_BACKUP_R2: backup as never }, { tenantId: globalScope.tenantId, jurisdiction: "global", limit: 1, cursor: first.nextCursor });
    expect(second).toMatchObject({ receiptsReplayed: 1, tombstonesCreated: 1, hasMore: false });
    const retry = await replayWorkspaceErasureBackupPage(db as never, primaryLedger as never,
      { WORKSPACE_ERASURE_BACKUP_R2: backup as never }, { tenantId: globalScope.tenantId, jurisdiction: "global", limit: 1 });
    expect(retry).toMatchObject({ receiptsReplayed: 1, tombstonesCreated: 0 });
    expect(db.tombstones).toHaveLength(2);
  });

  it("rejects changed or cross-tenant backup data before replay", async () => {
    const entry = await receipt();
    const backup = bucket();
    const key = workspaceErasureBackupKey(entry);
    backup.objects.set(key, JSON.stringify({ schema_version: 1, receipt: { ...entry, tenant_id: "tenant-b" }, receipt_sha256: "0".repeat(64) }));
    await expect(replayWorkspaceErasureBackupPage(new ErasureDb() as never, bucket() as never,
      { WORKSPACE_ERASURE_BACKUP_R2: backup as never }, { tenantId: globalScope.tenantId, jurisdiction: "global" }))
      .rejects.toThrow("workspace_erasure_backup_receipt_invalid");
  });
});
