import { describe, expect, it } from "vitest";
import { recordManualProviderDeletionEvidence, type ProviderDeletionOperation } from "./provider-deletion-reconciliation.js";

class ManualReceiptDb {
  operation: ProviderDeletionOperation = {
    id: `spdel_${"a".repeat(64)}`, tenant_id: "tenant", space_id: "space", project_id: "project", computer_id: "computer",
    allocation_id: "allocation", connection_id: null, provider: "agent37", external_id: "provider-resource", generation: 1,
    status: "indeterminate", owner_id: null, credential_ciphertext: null, credential_iv: null, connection_provider: null,
    base_url: null, connection_region: null, template_id: null, template_version: null, filesystem_id: null,
  };
  receipt: Record<string, string> | null = null;
  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...args: unknown[]) => { values = args; return statement; },
      first: async () => {
        if (sql.includes("SELECT o.*,computer.filesystem_id")) return values[0] === this.operation.id && values[1] === this.operation.tenant_id ? this.operation : null;
        if (sql.includes("FROM sandbox_provider_deletion_manual_receipts")) return this.receipt;
        if (sql.includes("SELECT\n          EXISTS (SELECT 1 FROM workspace_erasure_tombstones")) return { project_erased: 0, tenant_erased: 0 };
        return null;
      },
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO sandbox_provider_deletion_manual_receipts")) {
          if (!this.receipt && this.operation.external_id && values[0] === this.operation.id && values[1] === this.operation.tenant_id) {
            this.receipt = { evidence_ref_hash: String(values[2]), operator_id_hash: String(values[3]), observed_at: String(values[4]) };
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
        if (sql.includes("UPDATE sandbox_provider_deletion_operations SET status='confirmed_deleted'")) this.operation.status = "confirmed_deleted";
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  }
  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

describe("manual provider deletion receipts", () => {
  const evidence = { tenantId: "tenant", operationId: `spdel_${"a".repeat(64)}`, operatorId: "ops-operator-7",
    evidenceRef: "provider-ticket-INC-9031", observedAt: "2026-11-10T10:00:00.000Z" };

  it("stores only hashed evidence and idempotently confirms a manually verified absence", async () => {
    const db = new ManualReceiptDb();
    const first = await recordManualProviderDeletionEvidence(db as unknown as D1Database, evidence);
    expect(first).toEqual({ status: "confirmed_deleted", replay: false });
    expect(db.operation.status).toBe("confirmed_deleted");
    expect(db.receipt).toMatchObject({ evidence_ref_hash: /^[a-f0-9]{64}$/, operator_id_hash: /^[a-f0-9]{64}$/ });
    expect(JSON.stringify(db.receipt)).not.toContain(evidence.evidenceRef);
    expect(JSON.stringify(db.receipt)).not.toContain(evidence.operatorId);
    expect(await recordManualProviderDeletionEvidence(db as unknown as D1Database, evidence)).toEqual({ status: "confirmed_deleted", replay: true });
    await expect(recordManualProviderDeletionEvidence(db as unknown as D1Database, { ...evidence, evidenceRef: "provider-ticket-INC-9032" }))
      .rejects.toThrow("sandbox_provider_deletion_evidence_conflict");
  });

  it("does not accept manual deletion evidence when the external resource identity is missing", async () => {
    const db = new ManualReceiptDb();
    db.operation.external_id = null;
    await expect(recordManualProviderDeletionEvidence(db as unknown as D1Database, evidence))
      .rejects.toThrow("sandbox_provider_deletion_operation_unavailable");
    expect(db.receipt).toBeNull();
  });
});
