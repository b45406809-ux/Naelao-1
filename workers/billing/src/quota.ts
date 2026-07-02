// G-D04: Quota checking and enforcement using CF KV as cache with D1 fallback

export interface QuotaLimits {
  maxSpaces: number;
  maxKbDocs: number;
  maxApiCallsPerMonth: number;
}

export const PLAN_LIMITS: Record<string, QuotaLimits> = {
  free: { maxSpaces: 0, maxKbDocs: 0, maxApiCallsPerMonth: 0 },
  growth: { maxSpaces: 10, maxKbDocs: 1_000, maxApiCallsPerMonth: 100_000 },
  business: {
    maxSpaces: 50,
    maxKbDocs: 10_000,
    maxApiCallsPerMonth: 1_000_000,
  },
  enterprise: {
    maxSpaces: 999_999,
    maxKbDocs: 999_999,
    maxApiCallsPerMonth: 999_999_999,
  },
};

type QuotaMetric = "spaces" | "kb_docs" | "api_calls";

/** KV key format: quota:{orgId}:{metric} */
function kvKey(orgId: string, metric: QuotaMetric): string {
  return `quota:${orgId}:${metric}`;
}

/** TTL for KV quota cache entries — 5 minutes */
const QUOTA_TTL_SECONDS = 300;

/**
 * Get current usage for a metric.
 * Tries KV cache first (TTL 300s); falls back to a D1 count query.
 * KV is eventually consistent (~60s) — acceptable for soft quota enforcement,
 * NOT suitable for rate limiting.
 */
async function getCurrentUsage(
  kv: KVNamespace,
  db: D1Database,
  orgId: string,
  metric: QuotaMetric
): Promise<number> {
  const key = kvKey(orgId, metric);

  // Try cache first
  const cached = await kv.get(key, "text");
  if (cached !== null) {
    const parsed = Number.parseInt(cached, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }

  // Cache miss — query D1
  let count = 0;
  switch (metric) {
    case "spaces": {
      const row = await db
        .prepare(
          "SELECT COUNT(*) as cnt FROM spaces WHERE tenant_id = ? AND status = 'active'"
        )
        .bind(orgId)
        .first<{ cnt: number }>();
      count = row?.cnt ?? 0;
      break;
    }
    case "kb_docs": {
      const row = await db
        .prepare(
          "SELECT COUNT(*) as cnt FROM kb_documents WHERE tenant_id = ? AND status = 'indexed'"
        )
        .bind(orgId)
        .first<{ cnt: number }>();
      count = row?.cnt ?? 0;
      break;
    }
    case "api_calls": {
      const row = await db
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) as cnt
           FROM usage_events
           WHERE org_id = ?
             AND event_type = 'api_call'
             AND recorded_at >= datetime('now', 'start of month')`
        )
        .bind(orgId)
        .first<{ cnt: number }>();
      count = row?.cnt ?? 0;
      break;
    }
  }

  // Populate cache with the fresh value
  await kv.put(key, String(count), { expirationTtl: QUOTA_TTL_SECONDS });
  return count;
}

/**
 * Check whether an org is within quota for a given metric.
 * Returns {allowed, current, limit}.
 */
export async function checkQuota(
  kv: KVNamespace,
  db: D1Database,
  orgId: string,
  metric: QuotaMetric,
  planTier: string
): Promise<{ allowed: boolean; current: number; limit: number }> {
  const limits = PLAN_LIMITS[planTier] ?? {
    maxSpaces: 0,
    maxKbDocs: 0,
    maxApiCallsPerMonth: 0,
  };

  let limit: number;
  switch (metric) {
    case "spaces":
      limit = limits.maxSpaces;
      break;
    case "kb_docs":
      limit = limits.maxKbDocs;
      break;
    case "api_calls":
      limit = limits.maxApiCallsPerMonth;
      break;
  }

  const current = await getCurrentUsage(kv, db, orgId, metric);
  return { allowed: current < limit, current, limit };
}

/**
 * Increment the KV usage counter for an org/metric.
 * The KV counter is the source-of-truth for fast quota checks between cache refreshes.
 * D1 remains the authoritative store for accounting; this is a best-effort counter.
 */
export async function incrementUsage(
  kv: KVNamespace,
  orgId: string,
  metric: QuotaMetric,
  delta = 1
): Promise<void> {
  const key = kvKey(orgId, metric);
  const current = await kv.get(key, "text");
  const value = current !== null ? Number.parseInt(current, 10) || 0 : 0;
  // Write back incremented value; preserve TTL only if already cached (otherwise use fresh TTL)
  await kv.put(key, String(value + delta), {
    expirationTtl: QUOTA_TTL_SECONDS,
  });
}

/**
 * Invalidate quota KV cache for an org (call after space/doc deletion or plan change).
 */
export async function invalidateQuotaCache(
  kv: KVNamespace,
  orgId: string
): Promise<void> {
  const metrics: QuotaMetric[] = ["spaces", "kb_docs", "api_calls"];
  await Promise.all(metrics.map((m) => kv.delete(kvKey(orgId, m))));
}
