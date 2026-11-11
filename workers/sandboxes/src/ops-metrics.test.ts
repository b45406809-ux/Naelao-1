import { describe, expect, it, vi } from "vitest";
import { sandboxOpsAlerts, writeSandboxOpsMetric } from "./ops-metrics.js";

describe("bounded sandbox operations telemetry", () => {
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
      billedIdleMicros: 5,
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
});
