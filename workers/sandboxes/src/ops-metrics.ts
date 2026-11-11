export const SANDBOX_OPS_SIGNALS = [
  "pending_publications",
  "checkpoint_lag_ms",
  "stale_lease_fence",
  "reconciliation_age_ms",
  "runtime_startup_ms",
  "billed_idle_micros",
  "bridge_storage_bytes",
  "quota_pressure_ppm",
  "pending_erasure",
  "pending_erasure_age_ms",
  "provider_deletion_pending",
  "provider_deletion_indeterminate",
  "provider_deletion_age_ms",
  "billing_variance_micros",
] as const;
export type SandboxOpsSignal = (typeof SANDBOX_OPS_SIGNALS)[number];

export interface SandboxOpsAnalytics {
  writeDataPoint(point: { blobs: string[]; doubles: number[] }): void;
}

/** Emit only fixed signal names and bounded classes. Tenant, project, provider IDs, paths,
 * credentials, statements, and file contents never become metric dimensions. */
export function writeSandboxOpsMetric(
  analytics: SandboxOpsAnalytics | undefined,
  signal: SandboxOpsSignal,
  value: number,
  className = "all",
): void {
  if (!analytics || !SANDBOX_OPS_SIGNALS.includes(signal) || !Number.isFinite(value)) return;
  const boundedClass = ["all", "warning", "critical", "unknown"].includes(className) ? className : "unknown";
  try {
    analytics.writeDataPoint({
      blobs: [`sandbox.ops.${signal}`, boundedClass, "phase6", "", "", "", "", "", "sandbox-ops-v1"],
      doubles: [Math.max(0, Math.min(value, 9_000_000_000_000))],
    });
  } catch {
    // Observability must not delay erasure or provider recovery.
  }
}

export function boundedAgeMs(timestamp: string | null | undefined, nowMs = Date.now()): number {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.min(nowMs - parsed, 365 * 24 * 60 * 60_000)) : 0;
}

/** Nearest-rank p95 over a bounded observation window; invalid values are ignored. */
export function boundedP95Ms(values: readonly number[]): number {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.min(value, 9_000_000_000_000)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

export interface SandboxOpsMetricsEnv {
  PLATFORM_DB: D1Database;
  ANALYTICS?: SandboxOpsAnalytics;
}

export interface SandboxOpsSnapshot {
  pendingPublications: number;
  checkpointLagMs: number;
  reconciliationAgeMs: number;
  runtimeStartupMs: number;
  billedIdleMicros: number;
  bridgeStorageBytes: number;
  quotaPressurePpm: number;
  pendingErasure: number;
  pendingErasureAgeMs: number;
  providerDeletionPending: number;
  providerDeletionIndeterminate: number;
  providerDeletionAgeMs: number;
  billingVarianceMicros: number;
}

export function sandboxOpsAlerts(snapshot: SandboxOpsSnapshot): Array<{ signal: string; severity: "warning" | "critical" }> {
  const alerts: Array<{ signal: string; severity: "warning" | "critical" }> = [];
  if (snapshot.pendingPublications > 0 && snapshot.reconciliationAgeMs >= 60_000) alerts.push({ signal: "pending_publications", severity: "warning" });
  if (snapshot.checkpointLagMs >= 2_000) alerts.push({ signal: "checkpoint_lag_ms", severity: "warning" });
  if (snapshot.reconciliationAgeMs >= 300_000) alerts.push({ signal: "reconciliation_age_ms", severity: "critical" });
  if (snapshot.runtimeStartupMs >= 30_000) alerts.push({ signal: "runtime_startup_ms", severity: "warning" });
  if (snapshot.quotaPressurePpm >= 900_000) alerts.push({ signal: "quota_pressure_ppm", severity: "warning" });
  if (snapshot.pendingErasure > 0 && snapshot.pendingErasureAgeMs >= 900_000) alerts.push({ signal: "pending_erasure_age_ms", severity: "critical" });
  if (snapshot.providerDeletionPending > 0 && snapshot.providerDeletionAgeMs >= 300_000) alerts.push({ signal: "provider_deletion_age_ms", severity: "warning" });
  if (snapshot.providerDeletionIndeterminate > 0) alerts.push({ signal: "provider_deletion_indeterminate", severity: "critical" });
  if (snapshot.billingVarianceMicros > 0) alerts.push({ signal: "billing_variance_micros", severity: "critical" });
  return alerts;
}

/** Bounded aggregate probe for dashboards/alerts. All SQL dimensions are fixed enums and the
 * result contains no tenant/project/allocation IDs. */
export async function collectSandboxOpsMetrics(env: SandboxOpsMetricsEnv, nowMs = Date.now()): Promise<SandboxOpsSnapshot> {
  const [publications, publicationSamples, reconciliation, allocation, startupSamples, idle, storage, erasure, deletion, billing] = await Promise.all([
    env.PLATFORM_DB.prepare(`SELECT SUM(CASE WHEN status IN ('pending','recovery_required') THEN 1 ELSE 0 END) AS count,
      MIN(CASE WHEN status IN ('pending','recovery_required') THEN created_at END) AS oldest
      FROM sandbox_publications`).first<{ count: number; oldest: string | null }>(),
    env.PLATFORM_DB.prepare(`SELECT MAX(0,(julianday(updated_at)-julianday(created_at))*86400000) AS elapsed_ms
      FROM sandbox_publications WHERE status='published' ORDER BY updated_at DESC LIMIT 1000`).all<{ elapsed_ms: number }>(),
    env.PLATFORM_DB.prepare("SELECT MIN(updated_at) AS oldest FROM sandbox_operations WHERE status IN ('pending','running','indeterminate')").first<{ oldest: string | null }>(),
    env.PLATFORM_DB.prepare("SELECT MIN(updated_at) AS oldest FROM sandbox_allocations WHERE status IN ('intent','unknown','error')").first<{ oldest: string | null }>(),
    env.PLATFORM_DB.prepare(`SELECT MAX(0,(julianday(updated_at)-julianday(created_at))*86400000) AS elapsed_ms
      FROM sandbox_operations WHERE operation='start' AND status='complete' ORDER BY updated_at DESC LIMIT 1000`).all<{ elapsed_ms: number }>(),
    env.PLATFORM_DB.prepare("SELECT COALESCE(SUM(quantity_micros),0) AS total FROM sandbox_usage_events WHERE kind='billed_idle_micros'").first<{ total: number }>(),
    env.PLATFORM_DB.prepare(`SELECT COALESCE(SUM(size_bytes),0) AS total,
      COALESCE(MAX(snapshot_bytes),0) AS largest_snapshot FROM (
        SELECT b.size_bytes, SUM(b.size_bytes) OVER (PARTITION BY b.snapshot_id) AS snapshot_bytes
        FROM sandbox_workspace_blobs b WHERE b.snapshot_id IS NOT NULL
      )`).first<{ total: number; largest_snapshot: number }>(),
    env.PLATFORM_DB.prepare("SELECT COUNT(*) AS count,MIN(requested_at) AS oldest FROM workspace_erasure_tombstones WHERE status!='complete'").first<{ count: number; oldest: string | null }>(),
    env.PLATFORM_DB.prepare("SELECT COUNT(*) AS count,SUM(CASE WHEN status='indeterminate' THEN 1 ELSE 0 END) AS indeterminate,MIN(created_at) AS oldest FROM sandbox_provider_deletion_operations WHERE status IN ('pending','dispatching','deletion_requested','indeterminate')").first<{ count: number; indeterminate: number; oldest: string | null }>(),
    env.PLATFORM_DB.prepare("SELECT COALESCE(SUM(ABS(variance_micros)),0) AS total FROM sandbox_billing_reconciliations WHERE status='variance'").first<{ total: number }>(),
  ]);
  const snapshot: SandboxOpsSnapshot = {
    pendingPublications: Number(publications?.count ?? 0),
    checkpointLagMs: boundedP95Ms((publicationSamples.results ?? []).map((row) => typeof row.elapsed_ms === "number" ? row.elapsed_ms : Number.NaN)),
    reconciliationAgeMs: boundedAgeMs([reconciliation?.oldest, allocation?.oldest, publications?.oldest]
      .filter((value): value is string => typeof value === "string").sort()[0], nowMs),
    runtimeStartupMs: boundedP95Ms((startupSamples.results ?? []).map((row) => typeof row.elapsed_ms === "number" ? row.elapsed_ms : Number.NaN)),
    billedIdleMicros: Math.max(0, Number(idle?.total ?? 0)),
    bridgeStorageBytes: Math.max(0, Number(storage?.total ?? 0)),
    quotaPressurePpm: Math.max(0, Math.min(1_000_000, Math.round(Number(storage?.largest_snapshot ?? 0) / (64 * 1024 * 1024) * 1_000_000))),
    pendingErasure: Number(erasure?.count ?? 0),
    pendingErasureAgeMs: boundedAgeMs(erasure?.oldest, nowMs),
    providerDeletionPending: Number(deletion?.count ?? 0),
    providerDeletionIndeterminate: Number(deletion?.indeterminate ?? 0),
    providerDeletionAgeMs: boundedAgeMs(deletion?.oldest, nowMs),
    billingVarianceMicros: Math.max(0, Number(billing?.total ?? 0)),
  };
  writeSandboxOpsMetric(env.ANALYTICS, "pending_publications", snapshot.pendingPublications,
    snapshot.pendingPublications ? "warning" : "all");
  writeSandboxOpsMetric(env.ANALYTICS, "checkpoint_lag_ms", snapshot.checkpointLagMs,
    snapshot.checkpointLagMs >= 2_000 ? "warning" : "all");
  writeSandboxOpsMetric(env.ANALYTICS, "reconciliation_age_ms", snapshot.reconciliationAgeMs,
    snapshot.reconciliationAgeMs >= 60_000 ? "warning" : "all");
  writeSandboxOpsMetric(env.ANALYTICS, "runtime_startup_ms", snapshot.runtimeStartupMs,
    snapshot.runtimeStartupMs >= 30_000 ? "warning" : "all");
  writeSandboxOpsMetric(env.ANALYTICS, "billed_idle_micros", snapshot.billedIdleMicros);
  writeSandboxOpsMetric(env.ANALYTICS, "bridge_storage_bytes", snapshot.bridgeStorageBytes);
  writeSandboxOpsMetric(env.ANALYTICS, "quota_pressure_ppm", snapshot.quotaPressurePpm,
    snapshot.quotaPressurePpm >= 900_000 ? "warning" : "all");
  writeSandboxOpsMetric(env.ANALYTICS, "pending_erasure", snapshot.pendingErasure,
    snapshot.pendingErasure ? "warning" : "all");
  writeSandboxOpsMetric(env.ANALYTICS, "pending_erasure_age_ms", snapshot.pendingErasureAgeMs,
    snapshot.pendingErasureAgeMs >= 900_000 ? "critical" : "all");
  writeSandboxOpsMetric(env.ANALYTICS, "provider_deletion_pending", snapshot.providerDeletionPending,
    snapshot.providerDeletionPending ? "warning" : "all");
  writeSandboxOpsMetric(env.ANALYTICS, "provider_deletion_indeterminate", snapshot.providerDeletionIndeterminate,
    snapshot.providerDeletionIndeterminate ? "critical" : "all");
  writeSandboxOpsMetric(env.ANALYTICS, "provider_deletion_age_ms", snapshot.providerDeletionAgeMs,
    snapshot.providerDeletionAgeMs >= 300_000 ? "warning" : "all");
  writeSandboxOpsMetric(env.ANALYTICS, "billing_variance_micros", snapshot.billingVarianceMicros,
    snapshot.billingVarianceMicros ? "critical" : "all");
  return snapshot;
}
