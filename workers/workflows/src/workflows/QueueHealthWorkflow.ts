/** Durable queue telemetry workflow. Interval analytics never stands in for current depth. */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { readBoundedResponseJson } from "@naelao/http";
import type { Env } from "../env.js";
import {
  buildQueueHealthReport,
  normalizeQueueAnalytics,
  persistQueueHealthReport,
  QUEUE_ANALYTICS_ROW_LIMIT,
  type QueueAnalyticsRow,
  type QueueIntervalMetrics,
  type QueueHealthSource,
} from "./queue-health-model.js";

export interface QueueHealthParams {
  triggeredAt: string;
}

interface QueueAnalyticsResponse {
  errors?: Array<{ message?: unknown }>;
  data?: {
    viewer?: {
      accounts?: Array<{
        queueMetrics?: QueueAnalyticsRow[];
      }>;
    };
  };
}

export class QueueHealthWorkflow extends WorkflowEntrypoint<Env, QueueHealthParams> {
  async run(event: WorkflowEvent<QueueHealthParams>, step: WorkflowStep): Promise<void> {
    const retry = {
      retries: { limit: 2, delay: 5000, backoff: "exponential" as const },
      timeout: 30_000,
    };

    const observedAt = new Date().toISOString();
    let source: QueueHealthSource = "unavailable";
    let metrics: ReturnType<typeof normalizeQueueAnalytics> = [];
    let mayBeTruncated = false;
    let unavailableReason: "credentials_missing" | "provider_api_unavailable" | "no_queue_rows" | undefined;

    if (!this.env.CF_ACCOUNT_ID || !this.env.CF_API_TOKEN) {
      unavailableReason = "credentials_missing";
    } else {
      try {
        const observed = await step.do("fetch-queue-analytics", retry, async () => this.fetchQueueAnalytics());
        source = "cloudflare_graphql_analytics";
        metrics = observed.metrics;
        mayBeTruncated = observed.returnedRows >= QUEUE_ANALYTICS_ROW_LIMIT;
        if (!metrics.length) unavailableReason = "no_queue_rows";
      } catch {
        unavailableReason = "provider_api_unavailable";
      }
    }

    const report = buildQueueHealthReport({
      triggeredAt: event.payload.triggeredAt,
      observedAt,
      source,
      metrics,
      mayBeTruncated,
      ...(unavailableReason ? { unavailableReason } : {}),
    });

    if (report.status === "degraded") {
      console.error(`[QueueHealth] degraded telemetry at ${report.observedAt}; alerts=${report.alerts.length}`);
    } else {
      console.warn(`[QueueHealth] status=${report.status} at ${report.observedAt}; alerts=${report.alerts.length}`);
    }

    // Persistence is a required step. D1 failure retries the workflow and then fails visibly;
    // it cannot turn missing history into a healthy queue result.
    await step.do("persist-queue-health-and-operator-alerts", retry, async () => {
      await persistQueueHealthReport(this.env.PLATFORM_DB, report);
      return { status: report.status, alertCount: report.alerts.length };
    });
  }

  private async fetchQueueAnalytics(): Promise<{ metrics: QueueIntervalMetrics[]; returnedRows: number }> {
    const observedAt = new Date().toISOString();
    const windowEnd = observedAt;
    const windowStart = new Date(Date.parse(windowEnd) - 30 * 60 * 1000).toISOString();
    const query = `
      query QueueMetrics($accountTag: string!, $since: Time!, $until: Time!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            queueMetrics: queuesAdaptiveGroups(
              filter: { datetime_geq: $since, datetime_leq: $until }
              limit: ${QUEUE_ANALYTICS_ROW_LIMIT}
            ) {
              dimensions { queueId queueName }
              sum { messages messagesDelivered messagesFailed messagesDeadLettered }
            }
          }
        }
      }
    `;

    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.CF_API_TOKEN}`,
      },
      body: JSON.stringify({
        query,
        variables: { accountTag: this.env.CF_ACCOUNT_ID, since: windowStart, until: windowEnd },
      }),
    });
    if (!response.ok) throw new Error(`queue_analytics_http_${response.status}`);

    const payload = await readBoundedResponseJson<QueueAnalyticsResponse>(response, 1024 * 1024);
    if (Array.isArray(payload.errors) && payload.errors.length) throw new Error("queue_analytics_query_failed");
    if (!Array.isArray(payload.data?.viewer?.accounts)) throw new Error("queue_analytics_shape_invalid");
    const rows = payload.data.viewer.accounts.flatMap((account) => Array.isArray(account.queueMetrics) ? account.queueMetrics : []);
    return { metrics: normalizeQueueAnalytics(rows, observedAt, windowStart, windowEnd), returnedRows: rows.length };
  }
}
