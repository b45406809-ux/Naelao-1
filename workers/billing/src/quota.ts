// G-D04: Quota checking and enforcement using CF KV as cache with D1 fallback

export interface QuotaLimits {
  maxSpaces: number;
  maxKbDocs: number;
  maxApiCallsPerMonth: number;
  // P0-3: a builder's own monthly LLM token usage chatting with their Space Assistant (not
  // project-scoped, not a signed-in product end user — those have their own separate wallet/
  // credit gates). Numbers match @naelao/entitlements' PLAN_LIMITS.monthly_tokens exactly so the
  // two systems agree on what each tier is entitled to.
  maxMonthlyTokens: number;
  // §A1.26: the same builder-Space-Assistant scoping as maxMonthlyTokens, but for Cloudflare
  // infra consumption (isolate/container/workflow-step credits, billing-core's
  // infraTimeToCredits) rather than LLM tokens. Numbers match @naelao/entitlements'
  // PLAN_LIMITS.monthly_infra_credits exactly — keep both in sync in the same commit.
  maxMonthlyInfraCredits: number;
}

export const PLAN_LIMITS: Record<string, QuotaLimits> = {
  free: { maxSpaces: 0, maxKbDocs: 0, maxApiCallsPerMonth: 0, maxMonthlyTokens: 100_000, maxMonthlyInfraCredits: 5_000 },
  growth: { maxSpaces: 10, maxKbDocs: 1_000, maxApiCallsPerMonth: 100_000, maxMonthlyTokens: 2_000_000, maxMonthlyInfraCredits: 100_000 },
  business: {
    maxSpaces: 50,
    maxKbDocs: 10_000,
    maxApiCallsPerMonth: 1_000_000,
    maxMonthlyTokens: 20_000_000,
    maxMonthlyInfraCredits: 1_000_000,
  },
  enterprise: {
    maxSpaces: 999_999,
    maxKbDocs: 999_999,
    maxApiCallsPerMonth: 999_999_999,
    maxMonthlyTokens: 200_000_000,
    maxMonthlyInfraCredits: 10_000_000,
  },
};

type QuotaMetric = "spaces" | "kb_docs" | "api_calls" | "llm_tokens" | "infra_credits";

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
    case "llm_tokens": {
      const row = await db
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) as cnt
           FROM usage_events
           WHERE org_id = ?
             AND event_type = 'llm_tokens'
             AND recorded_at >= datetime('now', 'start of month')`
        )
        .bind(orgId)
        .first<{ cnt: number }>();
      count = row?.cnt ?? 0;
      break;
    }
    case "infra_credits": {
      const row = await db
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) as cnt
           FROM usage_events
           WHERE org_id = ?
             AND event_type = 'infra_credits'
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
    maxMonthlyTokens: 0,
    maxMonthlyInfraCredits: 0,
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
    case "llm_tokens":
      limit = limits.maxMonthlyTokens;
      break;
    case "infra_credits":
      limit = limits.maxMonthlyInfraCredits;
      break;
  }

  const current = await getCurrentUsage(kv, db, orgId, metric);
  return { allowed: current < limit, current, limit };
}

/**
 * F12: this used to be a KV read-modify-write (get -> parseInt -> put(value + delta)) — not
 * atomic, so concurrent calls for the same org/metric can lose increments (classic
 * read-then-write race). It also used a sliding `expirationTtl` on every write, so an org with
 * continuous traffic could keep resetting its own cache's TTL forward indefinitely and never
 * naturally fall back to a fresh D1 read — turning a bounded ~300s staleness window into
 * potentially unbounded drift under sustained load.
 *
 * `getCurrentUsage`'s D1 fallback is already correct and atomic in the way that matters here —
 * it's a live `COUNT`/`SUM` aggregate over the authoritative rows (`spaces`, `kb_documents`,
 * `usage_events`), not an accumulator that could itself drift. So instead of maintaining a
 * second, independently-incremented number that has to somehow stay in sync with that
 * aggregate, this just invalidates the cache on every usage event — the next `checkQuota` call
 * is forced back through the real aggregate query instead of trusting a number nothing can
 * prove is still correct. Trades one extra D1 read per post-cache-miss quota check for
 * eliminating the race entirely.
 */
export async function recordUsageEvent(
  kv: KVNamespace,
  orgId: string,
  metric: QuotaMetric
): Promise<void> {
  await kv.delete(kvKey(orgId, metric));
}

/**
 * Invalidate quota KV cache for an org (call after space/doc deletion or plan change).
 */
export async function invalidateQuotaCache(
  kv: KVNamespace,
  orgId: string
): Promise<void> {
  const metrics: QuotaMetric[] = ["spaces", "kb_docs", "api_calls", "llm_tokens", "infra_credits"];
  await Promise.all(metrics.map((m) => kv.delete(kvKey(orgId, m))));
}
