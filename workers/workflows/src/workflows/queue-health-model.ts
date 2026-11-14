export type QueueHealthSource = "cloudflare_graphql_analytics" | "unavailable";
export type QueueHealthStatus = "unknown" | "incomplete" | "degraded";
export const QUEUE_ANALYTICS_ROW_LIMIT = 100;

export interface QueueIntervalMetrics {
  queueId: string;
  queueName: string;
  source: "cloudflare_graphql_analytics";
  observedAt: string;
  windowStart: string;
  windowEnd: string;
  messages: number | null;
  messagesDelivered: number | null;
  messagesFailed: number | null;
  messagesDeadLettered: number | null;
  errorRate: number | null;
  currentBacklogDepth: null;
  oldestMessageAgeSeconds: null;
  currentDlqDepth: null;
}

export interface QueueHealthAlert {
  code: string;
  message: string;
  queueId?: string;
  queueName?: string;
}

export interface QueueHealthReport {
  triggeredAt: string;
  observedAt: string;
  source: QueueHealthSource;
  status: QueueHealthStatus;
  unavailableReason?: "credentials_missing" | "provider_api_unavailable" | "no_queue_rows";
  metrics: QueueIntervalMetrics[];
  alerts: QueueHealthAlert[];
}

export interface QueueAnalyticsRow {
  dimensions?: { queueId?: unknown; queueName?: unknown };
  sum?: { messages?: unknown; messagesDelivered?: unknown; messagesFailed?: unknown; messagesDeadLettered?: unknown };
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The GraphQL endpoint returns interval totals, not current queue/DLQ depth or oldest age. */
export function normalizeQueueAnalytics(
  rows: QueueAnalyticsRow[],
  observedAt: string,
  windowStart: string,
  windowEnd: string,
): QueueIntervalMetrics[] {
  const result: QueueIntervalMetrics[] = [];
  for (const row of rows) {
    const queueId = row.dimensions?.queueId;
    const queueName = row.dimensions?.queueName;
    const messages = finiteCount(row.sum?.messages);
    const delivered = finiteCount(row.sum?.messagesDelivered);
    const failed = finiteCount(row.sum?.messagesFailed);
    const deadLettered = finiteCount(row.sum?.messagesDeadLettered);
    if (typeof queueId !== "string" || !queueId || typeof queueName !== "string" || !queueName ||
        messages === null || delivered === null || failed === null || deadLettered === null) continue;
    result.push({
      queueId,
      queueName,
      source: "cloudflare_graphql_analytics",
      observedAt,
      windowStart,
      windowEnd,
      messages,
      messagesDelivered: delivered,
      messagesFailed: failed,
      messagesDeadLettered: deadLettered,
      errorRate: messages > 0 ? Math.min(1, failed / messages) : null,
      currentBacklogDepth: null,
      oldestMessageAgeSeconds: null,
      currentDlqDepth: null,
    });
  }
  return result;
}

export function buildQueueHealthReport(input: {
  triggeredAt: string;
  observedAt: string;
  source: QueueHealthSource;
  metrics: QueueIntervalMetrics[];
  mayBeTruncated?: boolean;
  unavailableReason?: QueueHealthReport["unavailableReason"];
}): QueueHealthReport {
  const alerts: QueueHealthAlert[] = [];
  let degraded = false;

  if (input.mayBeTruncated) {
    alerts.push({
      code: "queue_analytics_row_limit_reached",
      message: `Queue interval analytics returned the ${QUEUE_ANALYTICS_ROW_LIMIT}-row query limit; additional queues may be omitted from this report.`,
    });
  }

  if (input.source === "unavailable" || input.metrics.length === 0) {
    alerts.push({
      code: input.unavailableReason ?? "no_queue_rows",
      message: input.unavailableReason === "credentials_missing"
        ? "Queue telemetry credentials are not configured; current queue state is unknown."
        : input.unavailableReason === "provider_api_unavailable"
          ? "Queue telemetry could not be read after retries; current queue state is unknown."
          : "Queue telemetry returned no queue rows; current queue state is unknown.",
    });
    return {
      triggeredAt: input.triggeredAt,
      observedAt: input.observedAt,
      source: input.source,
      status: "unknown",
      ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
      metrics: input.metrics,
      alerts,
    };
  }

  for (const metric of input.metrics) {
    alerts.push({
      code: "current_queue_state_unavailable",
      message: `Queue ${metric.queueName} (${metric.queueId}) current backlog, oldest age, and DLQ depth are unavailable; interval totals are not current depth.`,
      queueId: metric.queueId,
      queueName: metric.queueName,
    });
    if (metric.errorRate === null) {
      alerts.push({
        code: "consumer_error_rate_unavailable",
        message: `Queue ${metric.queueName} (${metric.queueId}) had no interval message denominator; consumer error rate is unknown.`,
        queueId: metric.queueId,
        queueName: metric.queueName,
      });
    } else if (metric.errorRate > 0.5) {
      degraded = true;
      alerts.push({
        code: "consumer_error_rate_high",
        message: `Queue ${metric.queueName} (${metric.queueId}) interval consumer error rate exceeded 50%.`,
        queueId: metric.queueId,
        queueName: metric.queueName,
      });
    }
  }

  return {
    triggeredAt: input.triggeredAt,
    observedAt: input.observedAt,
    source: input.source,
    status: degraded ? "degraded" : "incomplete",
    metrics: input.metrics,
    alerts,
  };
}

export async function queueHealthIncidentId(report: QueueHealthReport, alert: QueueHealthAlert): Promise<string> {
  const hour = report.observedAt.slice(0, 13);
  const identity = JSON.stringify([hour, alert.code, alert.queueId ?? null, alert.queueName ?? null]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `queue-health:${hex}`;
}

/** Store the audit record and operator-visible failure inbox entries atomically. */
export async function persistQueueHealthReport(
  db: Pick<D1Database, "prepare" | "batch">,
  report: QueueHealthReport,
): Promise<void> {
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO queue_health_checks
      (triggered_at,observed_at,source,status,unavailable_reason,metrics_json,alert_count,alerts_json)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(triggered_at) DO UPDATE SET observed_at=excluded.observed_at,source=excluded.source,
      status=excluded.status,unavailable_reason=excluded.unavailable_reason,metrics_json=excluded.metrics_json,
      alert_count=excluded.alert_count,alerts_json=excluded.alerts_json`)
    .bind(report.triggeredAt, report.observedAt, report.source, report.status, report.unavailableReason ?? null,
      JSON.stringify(report.metrics), report.alerts.length, JSON.stringify(report.alerts))];

  for (const alert of report.alerts) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO platform_failures
        (id,message_type,payload_json,failure_reason,failed_at,retry_count,reviewed)
      VALUES(?,?,?,?,?,0,0)`)
      .bind(await queueHealthIncidentId(report, alert), `queue_health.${report.status}`,
        JSON.stringify({ triggeredAt: report.triggeredAt, observedAt: report.observedAt, status: report.status, source: report.source, alert }),
        alert.code, report.observedAt));
  }

  await db.batch(statements);
}
