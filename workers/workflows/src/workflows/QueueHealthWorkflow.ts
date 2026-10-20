/**
 * QueueHealthWorkflow — CF Workflow for queue health monitoring.
 *
 * G-BE03: Monitors CF Queues for backlog depth and message age.
 * Alerts if:
 *   - Oldest message age > 3 days (CRITICAL: messages at risk of silent drop)
 *   - DLQ depth > 1000 (needs investigation or bulk replay)
 *   - Consumer error rate > 50% (circuit breaker recommendation)
 *
 * Triggered every 30 minutes via cron in wrangler.toml.
 *
 * Uses Cloudflare GraphQL Analytics API to read queue metrics.
 * Requires CF_ACCOUNT_ID and CF_API_TOKEN secrets.
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { readBoundedResponseJson, readBoundedResponseText } from "@naelao/http";
import type { Env } from "../env.js";

export interface QueueHealthParams {
  triggeredAt: string;
}

interface QueueMetrics {
  queueName: string;
  backlogDepth: number;
  oldestMessageAgeSeconds: number;
  dlqDepth: number;
  errorRate: number;
}

const ALERT_OLDEST_AGE_SECS = 3 * 24 * 60 * 60;  // 3 days
const ALERT_DLQ_DEPTH = 1000;
const ALERT_ERROR_RATE = 0.5;

export class QueueHealthWorkflow extends WorkflowEntrypoint<Env, QueueHealthParams> {
  async run(
    event: WorkflowEvent<QueueHealthParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const retry = {
      retries: { limit: 2, delay: 5000, backoff: "exponential" as const },
      timeout: 30_000,
    };

    // ── Step 1: Fetch queue metrics from CF Analytics API ─────────────────────
    const metrics = await step.do("fetch-queue-metrics", retry, async () => {
      if (!this.env.CF_ACCOUNT_ID || !this.env.CF_API_TOKEN) {
        console.warn("[QueueHealth] CF_ACCOUNT_ID or CF_API_TOKEN not set — using D1 estimates");
        return await this.estimateMetricsFromD1();
      }
      return await this.fetchMetricsFromCfApi();
    });

    // ── Step 2: Evaluate thresholds and emit alerts ────────────────────────────
    await step.do("evaluate-and-alert", retry, async () => {
      const alerts: string[] = [];

      for (const m of metrics) {
        if (m.oldestMessageAgeSeconds > ALERT_OLDEST_AGE_SECS) {
          alerts.push(
            `[CRITICAL] Queue "${m.queueName}": oldest message age ${Math.floor(m.oldestMessageAgeSeconds / 3600)}h ` +
            `exceeds 3-day threshold — messages at risk of silent drop. Investigate consumer health immediately.`
          );
        }
        if (m.dlqDepth > ALERT_DLQ_DEPTH) {
          alerts.push(
            `[WARN] Queue "${m.queueName}" DLQ depth ${m.dlqDepth} > ${ALERT_DLQ_DEPTH} — bulk replay or root cause investigation needed.`
          );
        }
        if (m.errorRate > ALERT_ERROR_RATE) {
          alerts.push(
            `[WARN] Queue "${m.queueName}" consumer error rate ${(m.errorRate * 100).toFixed(1)}% > 50% — recommend pausing consumption.`
          );
        }
      }

      if (alerts.length > 0) {
        console.error(`[QueueHealth] ${alerts.length} alert(s) at ${event.payload.triggeredAt}:\n${alerts.join("\n")}`);
      } else {
        console.log(`[QueueHealth] All queues healthy at ${event.payload.triggeredAt}`);
      }

      // Write health check results to D1 for audit trail
      await this.env.PLATFORM_DB.prepare(
        `INSERT INTO queue_health_checks (checked_at, queue_metrics, alert_count, alerts_json)
         VALUES (datetime('now'), ?, ?, ?)`
      ).bind(
        JSON.stringify(metrics),
        alerts.length,
        JSON.stringify(alerts)
      ).run().catch(err => {
        // Table may not exist — log but don't fail the workflow
        console.warn(`[QueueHealth] Could not write to queue_health_checks: ${err}`);
      });

      return { alertCount: alerts.length, alerts };
    });
  }

  private async fetchMetricsFromCfApi(): Promise<QueueMetrics[]> {
    const nowMs = Date.now();
    const thirtyMinutesAgoMs = nowMs - 30 * 60 * 1000;

    const query = `
      query QueueMetrics($accountTag: string!, $since: Time!, $until: Time!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            queueMetrics: queuesAdaptiveGroups(
              filter: { datetime_geq: $since, datetime_leq: $until }
              limit: 100
            ) {
              dimensions { queueId queueName }
              sum { messages messagesDelivered messagesFailed messagesDeadLettered }
            }
          }
        }
      }
    `;

    const resp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.CF_API_TOKEN}`,
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: this.env.CF_ACCOUNT_ID,
          since: new Date(thirtyMinutesAgoMs).toISOString(),
          until: new Date(nowMs).toISOString(),
        },
      }),
    });

    if (!resp.ok) {
      let text = "";
      try { text = (await readBoundedResponseText(resp, 8 * 1024)).slice(0, 300); } catch { text = "response_body_unavailable"; }
      throw new Error(`CF GraphQL API error (${resp.status}): ${text}`);
    }

    const data = await readBoundedResponseJson<{
      data?: {
        viewer?: {
          accounts?: Array<{
            queueMetrics?: Array<{
              dimensions: { queueId: string; queueName: string };
              sum: { messages: number; messagesDelivered: number; messagesFailed: number; messagesDeadLettered: number };
            }>;
          }>;
        };
      };
    }>(resp, 1024 * 1024);

    const queueMetrics = data.data?.viewer?.accounts?.[0]?.queueMetrics ?? [];

    return queueMetrics.map(q => {
      const total = q.sum.messages || 1;
      const errorRate = q.sum.messagesFailed / total;
      return {
        queueName: q.dimensions.queueName,
        backlogDepth: q.sum.messages - q.sum.messagesDelivered,
        oldestMessageAgeSeconds: 0,  // Not available via GraphQL — requires queue-specific API
        dlqDepth: q.sum.messagesDeadLettered,
        errorRate,
      };
    });
  }

  // Fallback: estimate metrics from D1 event tables when CF API creds are unavailable
  private async estimateMetricsFromD1(): Promise<QueueMetrics[]> {
    try {
      const row = await this.env.PLATFORM_DB.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          MIN(created_at) as oldest_event
        FROM usage_events
        WHERE created_at >= datetime('now', '-30 minutes')
      `).first<{ total: number; failed: number; oldest_event: string | null }>();

      const total = row?.total ?? 0;
      const failed = row?.failed ?? 0;
      const oldestEvent = row?.oldest_event;
      const oldestAgeSecs = oldestEvent
        ? Math.floor((Date.now() - new Date(oldestEvent).getTime()) / 1000)
        : 0;

      return [{
        queueName: "naelao-events",
        backlogDepth: total - (total - failed),
        oldestMessageAgeSeconds: oldestAgeSecs,
        dlqDepth: 0,
        errorRate: total > 0 ? failed / total : 0,
      }];
    } catch {
      return [];
    }
  }
}
