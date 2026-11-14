import { describe, expect, it, vi } from "vitest";
import { buildQueueHealthReport, normalizeQueueAnalytics, persistQueueHealthReport, queueHealthIncidentId, QUEUE_ANALYTICS_ROW_LIMIT } from "./queue-health-model.js";

const observedAt = "2026-11-12T18:30:00.000Z";
const windowStart = "2026-11-12T18:00:00.000Z";
const trigger = "2026-11-12T18:30:00.000Z";

describe("queue health evidence model", () => {
  it("keeps interval totals distinct from current backlog, age and DLQ depth", () => {
    const metrics = normalizeQueueAnalytics([{
      dimensions: { queueId: "queue-1", queueName: "events" },
      sum: { messages: 100, messagesDelivered: 90, messagesFailed: 60, messagesDeadLettered: 10 },
    }], observedAt, windowStart, observedAt);

    expect(metrics).toEqual([expect.objectContaining({
      messages: 100,
      messagesDelivered: 90,
      messagesFailed: 60,
      messagesDeadLettered: 10,
      errorRate: 0.6,
      currentBacklogDepth: null,
      oldestMessageAgeSeconds: null,
      currentDlqDepth: null,
    })]);
    const report = buildQueueHealthReport({ triggeredAt: trigger, observedAt, source: "cloudflare_graphql_analytics", metrics });
    expect(report.status).toBe("degraded");
    expect(report.alerts.map((alert) => alert.code)).toContain("consumer_error_rate_high");
    expect(report.alerts.map((alert) => alert.code)).toContain("current_queue_state_unavailable");
  });

  it.each([
    ["credentials_missing", "Queue telemetry credentials are not configured; current queue state is unknown."],
    ["provider_api_unavailable", "Queue telemetry could not be read after retries; current queue state is unknown."],
    ["no_queue_rows", "Queue telemetry returned no queue rows; current queue state is unknown."],
  ] as const)("records %s as unknown instead of healthy", (reason, message) => {
    const report = buildQueueHealthReport({
      triggeredAt: trigger,
      observedAt,
      source: reason === "no_queue_rows" ? "cloudflare_graphql_analytics" : "unavailable",
      metrics: [],
      unavailableReason: reason,
    });
    expect(report.status).toBe("unknown");
    expect(report.alerts).toEqual([expect.objectContaining({ code: reason, message })]);
  });

  it("leaves a zero-traffic error rate unknown and skips malformed analytics rows", () => {
    const metrics = normalizeQueueAnalytics([
      { dimensions: { queueId: "queue-1", queueName: "events" }, sum: { messages: 0, messagesDelivered: 0, messagesFailed: 0, messagesDeadLettered: 0 } },
      { dimensions: { queueId: "queue-2", queueName: "invalid" }, sum: { messages: -1, messagesDelivered: 0, messagesFailed: 0, messagesDeadLettered: 0 } },
    ], observedAt, windowStart, observedAt);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.errorRate).toBeNull();
    const report = buildQueueHealthReport({ triggeredAt: trigger, observedAt, source: "cloudflare_graphql_analytics", metrics });
    expect(report.status).toBe("incomplete");
    expect(report.alerts.map((alert) => alert.code)).toContain("consumer_error_rate_unavailable");
  });

  it("warns when the GraphQL query reaches its row limit so coverage is not implied complete", () => {
    const metrics = normalizeQueueAnalytics([{
      dimensions: { queueId: "queue-1", queueName: "events" },
      sum: { messages: 4, messagesDelivered: 4, messagesFailed: 0, messagesDeadLettered: 0 },
    }], observedAt, windowStart, observedAt);
    const report = buildQueueHealthReport({
      triggeredAt: trigger, observedAt, source: "cloudflare_graphql_analytics", metrics, mayBeTruncated: true,
    });
    expect(QUEUE_ANALYTICS_ROW_LIMIT).toBe(100);
    expect(report.status).toBe("incomplete");
    expect(report.alerts).toContainEqual(expect.objectContaining({
      code: "queue_analytics_row_limit_reached",
      message: expect.stringContaining("additional queues may be omitted"),
    }));
  });

  it("uses stable incident IDs for retry of the same run and alert", async () => {
    const report = buildQueueHealthReport({
      triggeredAt: trigger, observedAt, source: "unavailable", metrics: [], unavailableReason: "credentials_missing",
    });
    const first = await queueHealthIncidentId(report, report.alerts[0]!);
    const retry = await queueHealthIncidentId(report, report.alerts[0]!);
    expect(first).toBe(retry);
  });

  it("atomically stores the health snapshot and admin-visible incident, and propagates DB errors", async () => {
    const report = buildQueueHealthReport({
      triggeredAt: trigger, observedAt, source: "unavailable", metrics: [], unavailableReason: "credentials_missing",
    });
    const bound: Array<{ sql: string; values: unknown[] }> = [];
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => {
        const statement = { sql, values };
        bound.push(statement);
        return statement;
      } }),
      batch: vi.fn(async (items: Array<{ sql: string; values: unknown[] }>) => { statements.push(...items); return []; }),
    };
    await persistQueueHealthReport(db as never, report);
    expect(db.batch).toHaveBeenCalledOnce();
    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toContain("INSERT INTO queue_health_checks");
    expect(statements[1]?.sql).toContain("INSERT OR IGNORE INTO platform_failures");
    expect(bound[1]?.values[1]).toBe("queue_health.unknown");

    const failedDb = { ...db, batch: vi.fn(async () => { throw new Error("d1_unavailable"); }) };
    await expect(persistQueueHealthReport(failedDb as never, report)).rejects.toThrow("d1_unavailable");
  });
});
