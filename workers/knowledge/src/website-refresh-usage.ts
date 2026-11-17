import { mintInternalToken } from "@naelao/http";
import { recordWebsiteRefreshUsageReceiptMetric } from "./retrieval-telemetry.js";

interface UsageReceiptEnvironment {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  BILLING_WORKER?: Fetcher;
  ANALYTICS?: AnalyticsEngineDataset;
}

interface PendingUsageReceipt {
  run_id: string;
  tenant_id: string;
  space_id: string;
  project_id: string;
  idempotency_key: string;
  attempt_count: number;
}

const RECEIPT_BATCH_LIMIT = 50;

/** Deliver stable, unpriced invocation receipts to Billing and retain failures for retry. */
export async function flushWebsiteRefreshUsageOutbox(env: UsageReceiptEnvironment, now = new Date()): Promise<number> {
  if (!env.BILLING_WORKER) return 0;
  const pending = await env.PLATFORM_DB.prepare(`SELECT run_id,tenant_id,space_id,project_id,idempotency_key,attempt_count
    FROM kb_website_refresh_usage_outbox WHERE status='pending' ORDER BY created_at,run_id LIMIT ${RECEIPT_BATCH_LIMIT}`)
    .all<PendingUsageReceipt>();
  let sent = 0;
  for (const receipt of pending.results ?? []) {
    const startedAt = Date.now();
    let errorCode: "billing_usage_unavailable" | "billing_usage_rejected" | null = null;
    try {
      const token = await mintInternalToken(env.PLATFORM_SECRET, receipt.tenant_id);
      const response = await env.BILLING_WORKER.fetch(new Request("http://billing-worker/billing/usage", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": receipt.tenant_id,
          "x-naelao-internal-token": token },
        // Do not send payer, rate-card, cost, provider, or decision fields. Billing records this
        // schema-v2 event for project usage but its admission rule cannot enqueue subscription metering.
        body: JSON.stringify({ schema_version: 2, event_type: "knowledge_website_refresh_invocation", quantity: 1,
          unit: "invocations", space_id: receipt.space_id, project_id: receipt.project_id,
          run_id: receipt.run_id, idempotency_key: receipt.idempotency_key }),
      }));
      if (!response.ok) errorCode = "billing_usage_rejected";
    } catch {
      errorCode = "billing_usage_unavailable";
    }
    const attemptedAt = now.toISOString();
    if (errorCode) {
      await env.PLATFORM_DB.prepare(`UPDATE kb_website_refresh_usage_outbox SET attempt_count=attempt_count+1,
        last_attempt_at=?,last_error_code=?,updated_at=? WHERE run_id=? AND status='pending'`)
        .bind(attemptedAt, errorCode, attemptedAt, receipt.run_id).run();
      recordWebsiteRefreshUsageReceiptMetric(env.ANALYTICS, "retry", Date.now() - startedAt, receipt.attempt_count + 1);
    } else {
      const updated = await env.PLATFORM_DB.prepare(`UPDATE kb_website_refresh_usage_outbox SET status='sent',
        attempt_count=attempt_count+1,last_attempt_at=?,last_error_code=NULL,sent_at=?,updated_at=?
        WHERE run_id=? AND status='pending'`)
        .bind(attemptedAt, attemptedAt, attemptedAt, receipt.run_id).run();
      if (Number(updated.meta.changes ?? 0) > 0) {
        sent++;
        recordWebsiteRefreshUsageReceiptMetric(env.ANALYTICS, "sent", Date.now() - startedAt, receipt.attempt_count + 1);
      }
    }
  }
  return sent;
}
