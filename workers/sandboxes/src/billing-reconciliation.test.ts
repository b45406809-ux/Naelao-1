import { describe, expect, it } from "vitest";
import { recordSandboxBillingReconciliation } from "./billing-reconciliation.js";

class FakeDb {
  rows = new Map<string, Record<string, unknown>>();
  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...next: unknown[]) => { values = next; return statement; },
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO sandbox_billing_reconciliations")) {
          const key = `${values[1]}:${values[2]}:${values[3]}:${values[4]}:${values[5]}`;
          if (this.rows.has(key)) return { success: true, meta: { changes: 0 } };
          this.rows.set(key, { id: values[0], measured_micros: values[6], provider_micros: values[7], variance_micros: values[8], status: values[9] });
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 1 } };
      },
      first: async () => {
        const key = `${values[0]}:${values[1]}:${values[2]}:${values[3]}:${values[4]}`;
        return this.rows.get(key) ?? null;
      },
    };
    return statement;
  }
}

const input = {
  tenantId: "tenant-a", provider: "agent37" as const,
  periodStart: "2026-11-01T00:00:00.000Z", periodEnd: "2026-12-01T00:00:00.000Z",
  statementRef: "invoice-2026-11", measuredMicros: 1_000_000, providerMicros: 1_050_000,
};

describe("sandbox billing recovery", () => {
  it("stores a durable variance receipt and replays it without charging or settlement", async () => {
    const db = new FakeDb();
    const first = await recordSandboxBillingReconciliation(db as never, input, "2026-12-02T00:00:00.000Z");
    const replay = await recordSandboxBillingReconciliation(db as never, input, "2026-12-03T00:00:00.000Z");
    expect(first).toMatchObject({ status: "variance", varianceMicros: 50_000, replay: false });
    expect(replay).toMatchObject({ status: "variance", varianceMicros: 50_000, replay: true, id: first.id });
    expect(db.rows.size).toBe(1);
  });

  it("rejects a changed amount under the same statement identity for manual reconciliation", async () => {
    const db = new FakeDb();
    await recordSandboxBillingReconciliation(db as never, input);
    await expect(recordSandboxBillingReconciliation(db as never, { ...input, providerMicros: 1_075_000 })).rejects.toThrow("sandbox_billing_statement_conflict");
  });
});
