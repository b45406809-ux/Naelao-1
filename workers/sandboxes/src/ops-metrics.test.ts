import { describe, expect, it, vi } from "vitest";
import { boundedP95Ms, collectSandboxOpsMetrics, sandboxOpsAlerts, writeSandboxOpsMetric } from "./ops-metrics.js";

describe("bounded sandbox operations telemetry", () => {
  it("reports nearest-rank p95 from finite nonnegative bounded observations", () => {
    expect(boundedP95Ms(Array.from({ length: 100 }, (_, index) => index + 1))).toBe(95);
    expect(boundedP95Ms([0, 10, Number.NaN, Number.POSITIVE_INFINITY, -1])).toBe(10);
    expect(boundedP95Ms([])).toBe(0);
    expect(boundedP95Ms([Number.MAX_VALUE])).toBe(9_000_000_000_000);
  });

  it("collects publication and startup p95 from bounded recent samples", async () => {
    const statements: string[] = [];
    const publicationSamples = Array.from({ length: 100 }, (_, index) => ({ elapsed_ms: index + 1 }));
    const startupSamples = Array.from({ length: 100 }, (_, index) => ({ elapsed_ms: (index + 1) * 10 }));
    const analyticsPoints: Array<{ blobs: string[]; doubles: number[] }> = [];
    const database = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          async first() {
            if (sql.includes("FROM sandbox_publications")) return { count: 0, oldest: null };
            if (sql.includes("FROM sandbox_operations WHERE status")) return { oldest: null };
            if (sql.includes("FROM sandbox_allocations")) return { oldest: null };
            if (sql.includes("FROM sandbox_provider_cost_receipts")) return { total: 41_000, receipt_count: 2 };
            if (sql.includes("FROM sandbox_workspace_blobs")) return { total: 0, largest_snapshot: 0 };
            if (sql.includes("FROM workspace_erasure_tombstones")) return { count: 0, oldest: null };
            if (sql.includes("FROM sandbox_provider_deletion_operations")) return { count: 0, indeterminate: 0, oldest: null };
            if (sql.includes("FROM sandbox_billing_reconciliations")) return { total: 0 };
            throw new Error("unexpected_sandbox_ops_query");
          },
          async all() {
            if (sql.includes("FROM sandbox_publications WHERE status='published'")) return { results: publicationSamples };
            if (sql.includes("FROM sandbox_operations WHERE operation='start'")) return { results: startupSamples };
            throw new Error("unexpected_sandbox_ops_sample_query");
          },
        };
      },
    } as unknown as D1Database;
    const snapshot = await collectSandboxOpsMetrics({ PLATFORM_DB: database, ANALYTICS: { writeDataPoint: (point) => analyticsPoints.push(point) } }, 1_000_000);
    expect(snapshot.checkpointLagMs).toBe(95);
    expect(snapshot.runtimeStartupMs).toBe(950);
    expect(snapshot.operatorImportedIdleCostMicros).toBe(41_000);
    expect(snapshot.operatorImportedIdleReceiptCount).toBe(2);
    expect(statements.filter((sql) => sql.includes("LIMIT 1000"))).toHaveLength(2);
    expect(statements.some((sql) => sql.includes("provenance='operator_imported'") && sql.includes("usage_kind='idle'"))).toBe(true);
    expect(analyticsPoints.find((point) => point.blobs[0] === "sandbox.ops.checkpoint_lag_ms")?.doubles).toEqual([95]);
    expect(analyticsPoints.find((point) => point.blobs[0] === "sandbox.ops.runtime_startup_ms")?.doubles).toEqual([950]);
  });

  it("uses only fixed signal labels and bounded value classes", () => {
    const writeDataPoint = vi.fn();
    writeSandboxOpsMetric({ writeDataPoint }, "provider_deletion_pending", 12, "critical");
    writeSandboxOpsMetric({ writeDataPoint }, "provider_deletion_pending", Number.POSITIVE_INFINITY, "tenant-secret-project");
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ["sandbox.ops.provider_deletion_pending", "critical", "phase6", "", "", "", "", "", "sandbox-ops-v1"],
      doubles: [12],
    });
  });

  it("raises bounded alerts for old erasure/provider work and billing variance", () => {
    expect(sandboxOpsAlerts({
      pendingPublications: 2,
      checkpointLagMs: 2_500,
      reconciliationAgeMs: 120_000,
      runtimeStartupMs: 31_000,
      operatorImportedIdleCostMicros: 5,
      operatorImportedIdleReceiptCount: 1,
      bridgeStorageBytes: 100,
      quotaPressurePpm: 950_000,
      pendingErasure: 1,
      pendingErasureAgeMs: 1_000_000,
      providerDeletionPending: 1,
      providerDeletionIndeterminate: 1,
      providerDeletionAgeMs: 400_000,
      billingVarianceMicros: 8,
    })).toEqual([
      { signal: "pending_publications", severity: "warning" },
      { signal: "checkpoint_lag_ms", severity: "warning" },
      { signal: "runtime_startup_ms", severity: "warning" },
      { signal: "quota_pressure_ppm", severity: "warning" },
      { signal: "pending_erasure_age_ms", severity: "critical" },
      { signal: "provider_deletion_age_ms", severity: "warning" },
      { signal: "provider_deletion_indeterminate", severity: "critical" },
      { signal: "billing_variance_micros", severity: "critical" },
    ]);
  });

  it("marks the imported idle-cost signal as unknown when no receipts exist", async () => {
    const analyticsPoints: Array<{ blobs: string[]; doubles: number[] }> = [];
    const database = {
      prepare(sql: string) {
        return {
          async first() {
            if (sql.includes("FROM sandbox_publications")) return { count: 0, oldest: null };
            if (sql.includes("FROM sandbox_operations WHERE status")) return { oldest: null };
            if (sql.includes("FROM sandbox_allocations")) return { oldest: null };
            if (sql.includes("FROM sandbox_provider_cost_receipts")) return { total: 0, receipt_count: 0 };
            if (sql.includes("FROM sandbox_workspace_blobs")) return { total: 0, largest_snapshot: 0 };
            if (sql.includes("FROM workspace_erasure_tombstones")) return { count: 0, oldest: null };
            if (sql.includes("FROM sandbox_provider_deletion_operations")) return { count: 0, indeterminate: 0, oldest: null };
            if (sql.includes("FROM sandbox_billing_reconciliations")) return { total: 0 };
            throw new Error("unexpected_sandbox_ops_query");
          },
          async all() { return { results: [] }; },
        };
      },
    } as unknown as D1Database;
    const snapshot = await collectSandboxOpsMetrics({ PLATFORM_DB: database, ANALYTICS: { writeDataPoint: point => analyticsPoints.push(point) } });
    expect(snapshot.operatorImportedIdleCostMicros).toBe(0);
    expect(snapshot.operatorImportedIdleReceiptCount).toBe(0);
    expect(analyticsPoints.find(point => point.blobs[0] === "sandbox.ops.operator_imported_idle_cost_micros")?.blobs[1]).toBe("unknown");
    expect(analyticsPoints.find(point => point.blobs[0] === "sandbox.ops.operator_imported_idle_receipt_count")?.blobs[1]).toBe("unknown");
  });
});
