import { describe, expect, it } from "vitest";
import { replayWorkspaceErasureLedgerReceipt, workspaceErasureLedgerKey, type WorkspaceErasureLedgerReceipt } from "./phase6-erasure.js";
import { sha256Hex } from "./workspace-contract.js";

class ReplayDb {
  tombstone: { tombstone_id: string; jurisdiction: string; status?: string } | null = null;
  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...next: unknown[]) => { values = next; return statement; },
      first: async () => {
        if (sql.includes("SELECT tombstone_id FROM workspace_erasure_tombstones")) return this.tombstone;
        if (sql.includes("SELECT tombstone_id,jurisdiction FROM workspace_erasure_tombstones")) return this.tombstone;
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO workspace_erasure_tombstones") && !this.tombstone) {
          this.tombstone = { tombstone_id: String(values[3]), jurisdiction: String(values[4]), status: "pending" };
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("SET status='pending',cleanup_phase='legacy'")) {
          if (this.tombstone) this.tombstone = { ...this.tombstone, status: "pending" };
        }
        return { success: true, meta: { changes: 0 } };
      },
    };
    return statement;
  }
}

describe("bulk erasure tombstone replay receipt", () => {
  it("rebuilds a tombstone from independently retained backup evidence idempotently", async () => {
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "erased-project", jurisdiction: "global" as const };
    const receipt: WorkspaceErasureLedgerReceipt = {
      tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: scope.projectId, jurisdiction: scope.jurisdiction,
      tombstone_id: `wser_${await sha256Hex(new TextEncoder().encode(`${scope.tenantId}\0${scope.spaceId}\0${scope.projectId}`))}`,
      requested_at: "2026-10-01T12:00:00.000Z",
    };
    const r2 = new Map<string, WorkspaceErasureLedgerReceipt>();
    const bucket = {
      async put(key: string, value: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }) {
        if (options?.onlyIf?.etagDoesNotMatch === "*" && r2.has(key)) return null;
        r2.set(key, JSON.parse(value));
        return { key };
      },
      async get(key: string) {
        const value = r2.get(key);
        return value ? { async json() { return structuredClone(value); } } : null;
      },
    };
    const db = new ReplayDb();
    expect(await replayWorkspaceErasureLedgerReceipt(db as unknown as D1Database, bucket as unknown as R2Bucket, receipt)).toBe(true);
    expect(db.tombstone).toMatchObject({ tombstone_id: receipt.tombstone_id, jurisdiction: "global", status: "pending" });
    expect(r2.get(workspaceErasureLedgerKey(scope))?.tombstone_id).toBe(receipt.tombstone_id);
    expect(await replayWorkspaceErasureLedgerReceipt(db as unknown as D1Database, bucket as unknown as R2Bucket, receipt)).toBe(false);
  });

  it("rejects a backup receipt whose scope-derived tombstone ID does not match", async () => {
    const db = new ReplayDb();
    const receipt: WorkspaceErasureLedgerReceipt = {
      tenant_id: "tenant", space_id: "space", project_id: "project", jurisdiction: "global",
      tombstone_id: `wser_${"0".repeat(64)}`, requested_at: "2026-10-01T12:00:00.000Z",
    };
    await expect(replayWorkspaceErasureLedgerReceipt(db as unknown as D1Database, {} as R2Bucket, receipt))
      .rejects.toThrow("workspace_erasure_ledger_invalid");
  });

  it("restarts cleanup when replaying a receipt over a completed tombstone after primary R2 restore", async () => {
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "restored-project", jurisdiction: "global" as const };
    const tombstoneId = `wser_${await sha256Hex(new TextEncoder().encode(`${scope.tenantId}\0${scope.spaceId}\0${scope.projectId}`))}`;
    const db = new ReplayDb();
    db.tombstone = { tombstone_id: tombstoneId, jurisdiction: "global", status: "complete" };
    const receipt: WorkspaceErasureLedgerReceipt = {
      tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: scope.projectId, jurisdiction: scope.jurisdiction,
      tombstone_id: tombstoneId, requested_at: "2026-10-01T12:00:00.000Z",
    };
    const bucket = { async put() { return { key: "ledger" }; }, async get() { return null; } };
    await replayWorkspaceErasureLedgerReceipt(db as unknown as D1Database, bucket as unknown as R2Bucket, receipt);
    expect(db.tombstone?.status).toBe("pending");
  });

  it("rejects a different immutable receipt already stored at the scope ledger key", async () => {
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" as const };
    const receipt: WorkspaceErasureLedgerReceipt = {
      tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: scope.projectId, jurisdiction: scope.jurisdiction,
      tombstone_id: `wser_${await sha256Hex(new TextEncoder().encode(`${scope.tenantId}\0${scope.spaceId}\0${scope.projectId}`))}`,
      requested_at: "2026-10-01T12:00:00.000Z",
    };
    const key = workspaceErasureLedgerKey(scope);
    const stored = { ...receipt, tombstone_id: `wser_${"f".repeat(64)}` };
    const bucket = {
      async put() { return null; },
      async get() { return { async json() { return stored; } }; },
    };
    await expect(replayWorkspaceErasureLedgerReceipt(new ReplayDb() as unknown as D1Database, bucket as unknown as R2Bucket, receipt))
      .rejects.toThrow("workspace_erasure_ledger_conflict");
    expect(key).toContain("workspace-erasure-ledger/");
  });
});
