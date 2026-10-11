// G-H02: Analytics query functions via CF Analytics Engine SQL API (ClickHouse dialect)
// The Analytics Engine SQL API is REST-only — it is NOT available as a Worker binding.
// Must use fetch() with the CF REST API.

// ── Internal query helper ─────────────────────────────────────────────────────

interface AnalyticsEngineResponse {
  data: Record<string, unknown>[];
  meta: unknown;
  rows: number;
  rows_before_limit_at_least?: number;
}

async function queryAnalytics(
  accountId: string,
  apiToken: string,
  sql: string
): Promise<{ data: Record<string, unknown>[]; meta: unknown }> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "text/plain",
    },
    body: sql,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(no body)");
    throw new Error(
      `Analytics Engine query failed: HTTP ${resp.status} — ${text}`
    );
  }

  const result = (await resp.json()) as AnalyticsEngineResponse;
  return { data: result.data ?? [], meta: result.meta ?? null };
}

// ── Helper: safe number coercion from query result ────────────────────────────

function toNum(val: unknown, fallback = 0): number {
  const n = Number(val);
  return isFinite(n) ? n : fallback;
}

// ── Space-level metrics ───────────────────────────────────────────────────────

export interface SpaceMetrics {
  totalSessions: number;
  totalMessages: number;
  avgSessionDuration: number; // ms
  totalTokens: number;
  avgRating: number;
  errorRate: number; // 0-1
}

export async function getSpaceMetrics(
  accountId: string,
  apiToken: string,
  spaceId: string,
  tenantId: string,
  periodDays = 30
): Promise<SpaceMetrics> {
  // ClickHouse dialect — index1=eventType, index2=tenantId, index3=spaceId
  // double1=timestamp unix ms, double2=durationMs, double3=tokenCount, double4=rating
  const sql = `
SELECT
  countIf(index1 = 'session_start')       AS total_sessions,
  countIf(index1 = 'message_sent')        AS total_messages,
  avgIf(double2, index1 = 'session_end')  AS avg_duration_ms,
  sumIf(double3, index1 = 'agent_response') AS total_tokens,
  avgIf(double4, index1 = 'rating_submitted' AND double4 > 0) AS avg_rating,
  if(count() = 0, 0, countIf(index1 = 'error') / count()) AS error_rate
FROM naelao_analytics
WHERE index2 = '${tenantId}'
  AND index3 = '${spaceId}'
  AND toDateTime(double1 / 1000) >= now() - INTERVAL ${periodDays} DAY
`.trim();

  const { data } = await queryAnalytics(accountId, apiToken, sql);
  const row = data[0] ?? {};

  return {
    totalSessions: toNum(row["total_sessions"]),
    totalMessages: toNum(row["total_messages"]),
    avgSessionDuration: toNum(row["avg_duration_ms"]),
    totalTokens: toNum(row["total_tokens"]),
    avgRating: toNum(row["avg_rating"]),
    errorRate: toNum(row["error_rate"]),
  };
}

// ── Tenant-level metrics ──────────────────────────────────────────────────────

export interface TenantMetrics {
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  activeSpaces: number;
  topSpaces: Array<{ spaceId: string; sessions: number }>;
}

export async function getTenantMetrics(
  accountId: string,
  apiToken: string,
  tenantId: string,
  periodDays = 30
): Promise<TenantMetrics> {
  // Two queries: aggregate totals + per-space breakdown for top spaces
  const aggregateSql = `
SELECT
  countIf(index1 = 'session_start')           AS total_sessions,
  countIf(index1 = 'message_sent')            AS total_messages,
  sumIf(double3, index1 = 'agent_response')   AS total_tokens,
  uniqIf(index3, index1 = 'session_start' AND index3 != '') AS active_spaces
FROM naelao_analytics
WHERE index2 = '${tenantId}'
  AND toDateTime(double1 / 1000) >= now() - INTERVAL ${periodDays} DAY
`.trim();

  const topSpacesSql = `
SELECT
  index3                              AS space_id,
  countIf(index1 = 'session_start')  AS sessions
FROM naelao_analytics
WHERE index2 = '${tenantId}'
  AND index3 != ''
  AND toDateTime(double1 / 1000) >= now() - INTERVAL ${periodDays} DAY
GROUP BY index3
ORDER BY sessions DESC
LIMIT 10
`.trim();

  const [aggResult, topResult] = await Promise.all([
    queryAnalytics(accountId, apiToken, aggregateSql),
    queryAnalytics(accountId, apiToken, topSpacesSql),
  ]);

  const agg = aggResult.data[0] ?? {};
  const topSpaces = topResult.data.map((r) => ({
    spaceId: String(r["space_id"] ?? ""),
    sessions: toNum(r["sessions"]),
  }));

  return {
    totalSessions: toNum(agg["total_sessions"]),
    totalMessages: toNum(agg["total_messages"]),
    totalTokens: toNum(agg["total_tokens"]),
    activeSpaces: toNum(agg["active_spaces"]),
    topSpaces,
  };
}

// ── Platform-level metrics (admin) ────────────────────────────────────────────

export interface PlatformMetrics {
  totalSessions: number;
  totalTenants: number;
  totalMessages: number;
  errorRate: number;
  p95LatencyMs: number;
}

export async function getPlatformMetrics(
  accountId: string,
  apiToken: string,
  periodDays = 30
): Promise<PlatformMetrics> {
  const sql = `
SELECT
  countIf(index1 = 'session_start')              AS total_sessions,
  uniqIf(index2, index2 != '')                   AS total_tenants,
  countIf(index1 = 'message_sent')               AS total_messages,
  if(count() = 0, 0, countIf(index1 = 'error') / count()) AS error_rate,
  quantileIf(0.95)(double2, index1 = 'agent_response' AND double2 > 0) AS p95_latency_ms
FROM naelao_analytics
WHERE toDateTime(double1 / 1000) >= now() - INTERVAL ${periodDays} DAY
`.trim();

  const { data } = await queryAnalytics(accountId, apiToken, sql);
  const row = data[0] ?? {};

  return {
    totalSessions: toNum(row["total_sessions"]),
    totalTenants: toNum(row["total_tenants"]),
    totalMessages: toNum(row["total_messages"]),
    errorRate: toNum(row["error_rate"]),
    p95LatencyMs: toNum(row["p95_latency_ms"]),
  };
}

// ── Runtime economics evidence ───────────────────────────────────────────────

export interface RuntimeEconomicsMetrics {
  periodDays: number;
  sampleCount: number;
  tierCounts: Record<string, number>;
  tierOneTwoShare: number;
  tierSixShare: number;
  successRate: number;
  averageDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  tierOneTwoP95DurationMs: number;
  totalTokens: number;
}

/** Query action-level execution evidence emitted by the agents worker.
 * This deliberately reports distribution and latency only. Infrastructure cost and gross margin
 * require Cloudflare billing exports and must not be inferred from action counts. */
export async function getRuntimeEconomicsMetrics(
  accountId: string,
  apiToken: string,
  periodDays = 30
): Promise<RuntimeEconomicsMetrics> {
  const sql = `
SELECT
  count() AS sample_count,
  countIf(double3 = 1) AS tier_1,
  countIf(double3 = 2) AS tier_2,
  countIf(double3 = 3) AS tier_3,
  countIf(double3 = 4) AS tier_4,
  countIf(double3 = 5) AS tier_5,
  countIf(double3 = 6) AS tier_6,
  if(count() = 0, 0, countIf(double3 IN (1, 2)) / count()) AS tier_1_2_share,
  if(count() = 0, 0, countIf(double3 = 6) / count()) AS tier_6_share,
  if(count() = 0, 0, sum(double4) / count()) AS success_rate,
  avg(double2) AS average_duration_ms,
  quantile(0.50)(double2) AS p50_duration_ms,
  quantile(0.95)(double2) AS p95_duration_ms,
  quantileIf(0.95)(double2, double3 IN (1, 2)) AS tier_1_2_p95_duration_ms,
  sum(double5) AS total_tokens
FROM naelao_agent_events
WHERE blob1 = 'tool.execution'
  AND toDateTime(double1 / 1000) >= now() - INTERVAL ${periodDays} DAY
`.trim();

  const { data } = await queryAnalytics(accountId, apiToken, sql);
  const row = data[0] ?? {};
  const tierCounts: Record<string, number> = {};
  for (let tier = 1; tier <= 6; tier++) tierCounts[String(tier)] = toNum(row[`tier_${tier}`]);
  return {
    periodDays,
    sampleCount: toNum(row["sample_count"]),
    tierCounts,
    tierOneTwoShare: toNum(row["tier_1_2_share"]),
    tierSixShare: toNum(row["tier_6_share"]),
    successRate: toNum(row["success_rate"]),
    averageDurationMs: toNum(row["average_duration_ms"]),
    p50DurationMs: toNum(row["p50_duration_ms"]),
    p95DurationMs: toNum(row["p95_duration_ms"]),
    tierOneTwoP95DurationMs: toNum(row["tier_1_2_p95_duration_ms"]),
    totalTokens: toNum(row["total_tokens"]),
  };
}
