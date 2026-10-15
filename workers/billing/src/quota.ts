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
  // Phase 4 (money): optional day/week ceilings on top of the monthly one — see
  // @naelao/entitlements' matching daily_tokens/weekly_tokens field for why these exist and why
  // it's a second, independently-maintained copy of the same numbers (same precedent as every
  // other field in this type). Undefined = no extra throttling on that window; every tier below
  // sets them.
  maxDailyTokens?: number;
  maxWeeklyTokens?: number;
}

export const PLAN_LIMITS: Record<string, QuotaLimits> = {
  free: {
    maxSpaces: 0,
    maxKbDocs: 0,
    maxApiCallsPerMonth: 0,
    maxMonthlyTokens: 100_000,
    maxMonthlyInfraCredits: 5_000,
    maxDailyTokens: 20_000,
    maxWeeklyTokens: 50_000,
  },
  growth: {
    maxSpaces: 10,
    maxKbDocs: 1_000,
    maxApiCallsPerMonth: 100_000,
    maxMonthlyTokens: 2_000_000,
    maxMonthlyInfraCredits: 100_000,
    maxDailyTokens: 200_000,
    maxWeeklyTokens: 700_000,
  },
  business: {
    maxSpaces: 50,
    maxKbDocs: 10_000,
    maxApiCallsPerMonth: 1_000_000,
    maxMonthlyTokens: 20_000_000,
    maxMonthlyInfraCredits: 1_000_000,
    maxDailyTokens: 2_000_000,
    maxWeeklyTokens: 7_000_000,
  },
  enterprise: {
    maxSpaces: 999_999,
    maxKbDocs: 999_999,
    maxApiCallsPerMonth: 999_999_999,
    maxMonthlyTokens: 200_000_000,
    maxMonthlyInfraCredits: 10_000_000,
    maxDailyTokens: 20_000_000,
    maxWeeklyTokens: 70_000_000,
  },
};

/** SQL gate fragments for atomically admitting an estimated LLM request beside real usage and
 * unexpired holds. Values are returned separately so the caller can append them to the D1 INSERT. */
export function llmReservationAdmission(orgId: string, estimatedTokens: number, limits: QuotaLimits, allowOverage: boolean): { predicate: string; bindings: Array<string | number> } {
  if (allowOverage) return { predicate: "1=1", bindings: [] };
  const windows = [
    { start: "datetime('now','start of day')", limit: limits.maxDailyTokens },
    { start: "datetime('now','-7 days')", limit: limits.maxWeeklyTokens },
    { start: "datetime('now','start of month')", limit: limits.maxMonthlyTokens },
  ].filter((window): window is { start: string; limit: number } => typeof window.limit === "number" && window.limit > 0);
  const bindings: Array<string | number> = [];
  const predicates = windows.map(window => {
    bindings.push(estimatedTokens, orgId, orgId, window.limit);
    return `? + COALESCE((SELECT SUM(quantity) FROM usage_events WHERE org_id=? AND event_type='llm_tokens' AND recorded_at>=${window.start}),0) + COALESCE((SELECT SUM(estimated_tokens) FROM llm_token_reservations WHERE org_id=? AND status='held' AND expires_at>datetime('now') AND created_at>=${window.start}),0) <= ?`;
  });
  return { predicate: predicates.length ? predicates.join(" AND ") : "1=1", bindings };
}

type QuotaMetric = "spaces" | "kb_docs" | "api_calls" | "llm_tokens" | "infra_credits";

/** KV key format: quota:{orgId}:{metric} */
function kvKey(orgId: string, metric: QuotaMetric): string {
  return `quota:${orgId}:${metric}`;
}

/** Phase 4 (money): the day/week-scoped sibling of kvKey — quota:{orgId}:{metric}:{window}. Kept
 *  separate from kvKey rather than folding a window param into it: every existing caller of
 *  kvKey/getCurrentUsage means "monthly" implicitly, and this avoids silently changing what those
 *  call sites cache under. */
function kvWindowKey(orgId: string, metric: WindowedMetric, window: UsageWindow): string {
  return `quota:${orgId}:${metric}:${window}`;
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
  const deletes = [kv.delete(kvKey(orgId, metric))];
  // Phase 4 (money): also drop the day/week windowed cache entries for this metric so
  // checkWindowedQuota is forced back through a fresh D1 read too, not just the monthly one.
  if (metric === "api_calls" || metric === "llm_tokens" || metric === "infra_credits") {
    deletes.push(
      kv.delete(kvWindowKey(orgId, metric, "day")),
      kv.delete(kvWindowKey(orgId, metric, "week")),
      kv.delete(kvWindowKey(orgId, metric, "month"))
    );
  }
  await Promise.all(deletes);
}

/**
 * Invalidate quota KV cache for an org (call after space/doc deletion or plan change).
 */
export async function invalidateQuotaCache(
  kv: KVNamespace,
  orgId: string
): Promise<void> {
  const metrics: QuotaMetric[] = ["spaces", "kb_docs", "api_calls", "llm_tokens", "infra_credits"];
  const windowedMetrics: WindowedMetric[] = ["api_calls", "llm_tokens", "infra_credits"];
  const windows: UsageWindow[] = ["day", "week", "month"];
  await Promise.all([
    ...metrics.map((m) => kv.delete(kvKey(orgId, m))),
    ...windowedMetrics.flatMap((m) => windows.map((w) => kv.delete(kvWindowKey(orgId, m, w)))),
  ]);
}

/** §A1.27: a "usage_events"-backed metric — the only ones a day/week/month rollup makes sense
 *  for (spaces/kb_docs are point-in-time counts, not accumulating events). */
type WindowedMetric = "api_calls" | "llm_tokens" | "infra_credits";
type UsageWindow = "day" | "week" | "month";

const WINDOW_SQL: Record<UsageWindow, string> = {
  day: "datetime('now', 'start of day')",
  week: "datetime('now', '-7 days')",
  month: "datetime('now', 'start of month')",
};

/** Uncached — direct D1 aggregate for one (metric, window) pair. Deliberately bypasses the KV
 *  cache `getCurrentUsage` uses for the monthly gate check: this feeds a usage DISPLAY (the
 *  context-usage UI), not an enforcement decision, so a moment of extra D1 load in exchange for
 *  never showing a builder a stale number is the right tradeoff here — unlike the monthly gate,
 *  which intentionally tolerates ~300s staleness to avoid a D1 read on every single run. */
async function getUsageForWindow(
  db: D1Database,
  orgId: string,
  metric: WindowedMetric,
  window: UsageWindow
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) as cnt
       FROM usage_events
       WHERE org_id = ?
         AND event_type = ?
         AND recorded_at >= ${WINDOW_SQL[window]}`
    )
    .bind(orgId, metric)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

export interface UsageWindowSummary {
  used: number;
  limit: number;
}

/**
 * §A1.27: day/week/month usage for a metric. Originally every window was reported against the
 * SAME monthly plan-tier limit ("there's no separate daily/weekly plan allowance") — Phase 4
 * (money) added real ones (QuotaLimits.maxDailyTokens/maxWeeklyTokens), so this now reports each
 * window against ITS OWN real ceiling when one exists, falling back to the monthly figure for a
 * window/metric that has no dedicated cap (api_calls has none; infra_credits has none yet either
 * — only llm_tokens does today). llm_tokens is the metric the context-window UI actually needs;
 * infra_credits/api_calls reuse the same shape for completeness.
 */
export async function getUsageSummary(
  db: D1Database,
  orgId: string,
  metric: WindowedMetric,
  planTier: string
): Promise<{ daily: UsageWindowSummary; weekly: UsageWindowSummary; monthly: UsageWindowSummary }> {
  const limits = PLAN_LIMITS[planTier] ?? {
    maxSpaces: 0, maxKbDocs: 0, maxApiCallsPerMonth: 0, maxMonthlyTokens: 0, maxMonthlyInfraCredits: 0,
  };
  const monthlyLimit =
    metric === "llm_tokens" ? limits.maxMonthlyTokens
    : metric === "infra_credits" ? limits.maxMonthlyInfraCredits
    : limits.maxApiCallsPerMonth;
  const dailyLimit = metric === "llm_tokens" ? (limits.maxDailyTokens ?? monthlyLimit) : monthlyLimit;
  const weeklyLimit = metric === "llm_tokens" ? (limits.maxWeeklyTokens ?? monthlyLimit) : monthlyLimit;

  const [daily, weekly, monthly] = await Promise.all([
    getUsageForWindow(db, orgId, metric, "day"),
    getUsageForWindow(db, orgId, metric, "week"),
    getUsageForWindow(db, orgId, metric, "month"),
  ]);
  return {
    daily: { used: daily, limit: dailyLimit },
    weekly: { used: weekly, limit: weeklyLimit },
    monthly: { used: monthly, limit: monthlyLimit },
  };
}

/** Phase 4 (money): the enforcement counterpart to getUsageSummary above — checkQuota only ever
 *  checked the monthly ceiling; this also checks day/week when the tier defines one, KV-cached
 *  per window with the same TTL/staleness tradeoff checkQuota's own monthly cache already accepts
 *  (a gate decision, not a UI number — unlike getUsageForWindow above, which stays uncached on
 *  purpose). Returns the FIRST breached window (day checked before week before month, though for
 *  a coherent set of tier numbers day/week/month are each proportionally tighter so day will
 *  almost always be the one that actually fires first in practice).
 *
 *  `allowOverage` is an org's own `orgs.allow_quota_overage` flag (Phase 4): when true, a real
 *  breach still reports `allowed: true` with `overage: true` set, instead of blocking — real
 *  usage keeps being recorded into usage_events exactly as it always has, this only changes
 *  whether enforceRunGates refuses the run over it. NOT metered billing — see the migration
 *  comment on allow_quota_overage for why that's deliberate. */
async function getCurrentUsageForWindow(
  kv: KVNamespace,
  db: D1Database,
  orgId: string,
  metric: WindowedMetric,
  window: UsageWindow
): Promise<number> {
  const key = kvWindowKey(orgId, metric, window);
  const cached = await kv.get(key, "text");
  if (cached !== null) {
    const parsed = Number.parseInt(cached, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const count = await getUsageForWindow(db, orgId, metric, window);
  await kv.put(key, String(count), { expirationTtl: QUOTA_TTL_SECONDS });
  return count;
}

export interface WindowedQuotaResult {
  allowed: boolean;
  current: number;
  limit: number;
  window: UsageWindow;
  overage?: boolean;
}

export async function checkWindowedQuota(
  kv: KVNamespace,
  db: D1Database,
  orgId: string,
  metric: WindowedMetric,
  planTier: string,
  allowOverage = false
): Promise<WindowedQuotaResult> {
  const limits = PLAN_LIMITS[planTier] ?? {
    maxSpaces: 0, maxKbDocs: 0, maxApiCallsPerMonth: 0, maxMonthlyTokens: 0, maxMonthlyInfraCredits: 0,
  };
  const limitForWindow = (window: UsageWindow): number | undefined => {
    if (metric !== "llm_tokens") {
      // No dedicated daily/weekly ceiling exists for api_calls/infra_credits yet — only monthly.
      return window === "month"
        ? metric === "infra_credits" ? limits.maxMonthlyInfraCredits : limits.maxApiCallsPerMonth
        : undefined;
    }
    if (window === "day") return limits.maxDailyTokens;
    if (window === "week") return limits.maxWeeklyTokens;
    return limits.maxMonthlyTokens;
  };

  const windows: UsageWindow[] = ["day", "week", "month"];
  const applicable = windows.filter((w) => limitForWindow(w) !== undefined);
  const usages = await Promise.all(applicable.map((w) => getCurrentUsageForWindow(kv, db, orgId, metric, w)));

  for (let i = 0; i < applicable.length; i++) {
    const window = applicable[i]!;
    const limit = limitForWindow(window)!;
    const current = usages[i]!;
    if (current >= limit) {
      return { allowed: allowOverage, current, limit, window, ...(allowOverage ? { overage: true } : {}) };
    }
  }

  // Nothing breached — report the monthly figure (every existing caller's headline number).
  const monthlyIdx = applicable.indexOf("month");
  const monthlyCurrent = monthlyIdx >= 0 ? usages[monthlyIdx]! : await getCurrentUsageForWindow(kv, db, orgId, metric, "month");
  return { allowed: true, current: monthlyCurrent, limit: limitForWindow("month") ?? 0, window: "month" };
}
