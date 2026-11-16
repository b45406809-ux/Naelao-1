import { mintInternalToken } from "@naelao/http";
import { flushWebsiteRefreshUsageOutbox } from "./website-refresh-usage.js";

const SCHEDULE_BATCH_LIMIT = 4;
const SCHEDULE_LEASE_MS = 3 * 60_000;
const SCHEDULE_FAILURE_BACKOFF_CAP_MINUTES = 360;

interface ScheduleEnvironment { PLATFORM_DB: D1Database; PLATFORM_SECRET: string; BILLING_WORKER?: Fetcher; KNOWLEDGE_WEBSITE_REFRESH_SCHEDULE_ENABLED?: string }
interface DueWebsiteRefresh {
  schedule_id: string; tenant_id: string; space_id: string; project_id: string; document_id: string;
  connection_ref: string; owner_user_id: string; enabled: number; interval_hours: 24 | 168; generation: number;
  due_at: string; failure_count: number; lease_expires_at: string | null; document_status: string | null;
  source_adapter: string | null; source_state: string | null; source_revision: number | null; source_url: string | null;
  source_requested_url: string | null; source_content_sha256: string | null; title: string | null;
  document_connection_ref: string | null; connection_status: string | null; connection_owner_user_id: string | null;
  project_role_rank: number | null;
}
interface SchedulePreview {
  content: string; requested_url: string; final_url: string; preview_sha256: string; preview_token: string;
  refresh_operation_id: string; expected_source_revision: number;
}
export interface ScheduledRefreshRunResult { selected: number; claimed: number; completed: number; failed: number; paused: number }
type InternalFetcher = (request: Request, env: ScheduleEnvironment, ctx: ExecutionContext) => Promise<Response>;

function errorCodeFrom(body: unknown): string {
  if (body && typeof body === "object" && "error_code" in body && typeof body.error_code === "string"
    && /^[a-z0-9_]{1,96}$/.test(body.error_code)) return body.error_code;
  return "website_refresh_unavailable";
}
async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
async function refreshKey(schedule: DueWebsiteRefresh): Promise<string> {
  const data = new TextEncoder().encode(schedule.schedule_id + ":" + schedule.due_at + ":" + schedule.generation);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  return "scheduled_" + hex.slice(0, 48);
}
function intervalFrom(hours: number): 24 | 168 { return hours === 168 ? 168 : 24; }
function nextRun(now: Date, intervalHours: number): string {
  return new Date(now.getTime() + intervalFrom(intervalHours) * 60 * 60_000).toISOString();
}
async function recordFailure(env: ScheduleEnvironment, schedule: DueWebsiteRefresh, leaseToken: string, now: Date,
  errorCode: string, retryAt?: string): Promise<boolean> {
  const minutes = Math.min(SCHEDULE_FAILURE_BACKOFF_CAP_MINUTES, 5 * 2 ** Math.min(schedule.failure_count, 6));
  const backoffAt = new Date(now.getTime() + minutes * 60_000).toISOString();
  const providerRetryAt = retryAt && Number.isFinite(Date.parse(retryAt)) ? new Date(retryAt).toISOString() : null;
  const nextAttemptAt = providerRetryAt && providerRetryAt > backoffAt ? providerRetryAt : backoffAt;
  const result = await env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_schedules SET failure_count=MIN(failure_count+1,100),
    last_run_at=?,last_result='failed',last_error_code=?,next_run_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?
    WHERE id=? AND enabled=1 AND generation=? AND lease_token=?`)
    .bind(now.toISOString(), errorCode, nextAttemptAt, now.toISOString(), schedule.schedule_id, schedule.generation, leaseToken).run();
  return Number(result.meta.changes ?? 0) > 0;
}
async function pauseSchedule(env: ScheduleEnvironment, schedule: DueWebsiteRefresh, now: Date, errorCode: string): Promise<boolean> {
  const result = await env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_schedules SET enabled=0,generation=generation+1,
    next_run_at=NULL,last_result='paused',last_error_code=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?
    WHERE id=? AND enabled=1 AND generation=?`)
    .bind(errorCode, now.toISOString(), schedule.schedule_id, schedule.generation).run();
  return Number(result.meta.changes ?? 0) > 0;
}
async function finishUnchanged(env: ScheduleEnvironment, schedule: DueWebsiteRefresh, leaseToken: string,
  preview: SchedulePreview, now: Date): Promise<boolean> {
  const next = nextRun(now, schedule.interval_hours);
  const results = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`UPDATE kb_documents SET source_last_success_at=?,source_refresh_failures=0,
      source_last_error_code=NULL,source_next_attempt_at=NULL,updated_at=?
      WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND source_revision=? AND source_state='current'
        AND source_content_sha256=? AND source_connection_ref=? AND status IN ('indexed','failed')
        AND EXISTS (SELECT 1 FROM website_connections wc WHERE wc.id=source_connection_ref AND wc.status='active'
          AND wc.owner_user_id=? AND wc.project_id=kb_documents.project_id)
        AND EXISTS (SELECT 1 FROM project_access pa WHERE pa.tenant_id=kb_documents.tenant_id AND pa.space_id=kb_documents.space_id
          AND pa.project_id=kb_documents.project_id AND pa.user_id=? AND pa.role_rank>=40)
        AND EXISTS (SELECT 1 FROM kb_source_refresh_schedules rs WHERE rs.id=? AND rs.enabled=1 AND rs.lease_token=? AND rs.generation=?)`)
      .bind(now.toISOString(), now.toISOString(), schedule.document_id, schedule.tenant_id, schedule.space_id, schedule.project_id,
        preview.expected_source_revision, preview.preview_sha256, schedule.connection_ref, schedule.owner_user_id,
        schedule.owner_user_id, schedule.schedule_id, leaseToken, schedule.generation),
    env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_operations SET state='completed',completed_at=?,next_attempt_at=NULL,
      error_code=NULL,updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND document_id=?
        AND state='preview_ready' AND source_revision=? AND preview_sha256=? AND EXISTS (
          SELECT 1 FROM kb_documents d WHERE d.id=kb_source_refresh_operations.document_id
            AND d.source_revision=kb_source_refresh_operations.source_revision AND d.source_content_sha256=? AND d.source_state='current'
        )`)
      .bind(now.toISOString(), now.toISOString(), preview.refresh_operation_id, schedule.tenant_id, schedule.space_id,
        schedule.project_id, schedule.document_id, preview.expected_source_revision, preview.preview_sha256, preview.preview_sha256),
    env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_schedules SET last_run_at=?,last_result='unchanged',last_error_code=NULL,
      failure_count=0,next_run_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?
      WHERE id=? AND enabled=1 AND generation=? AND lease_token=? AND EXISTS (
        SELECT 1 FROM kb_source_refresh_operations ro WHERE ro.id=? AND ro.state='completed'
      )`)
      .bind(now.toISOString(), next, now.toISOString(), schedule.schedule_id, schedule.generation, leaseToken, preview.refresh_operation_id),
  ]);
  return results.every((item) => Number(item.meta.changes ?? 0) > 0);
}

export async function runScheduledWebsiteRefreshes(env: ScheduleEnvironment, fetchInternal: InternalFetcher,
  ctx: ExecutionContext, now = new Date()): Promise<ScheduledRefreshRunResult> {
  if (env.KNOWLEDGE_WEBSITE_REFRESH_SCHEDULE_ENABLED !== "true") {
    // Continue delivering prior receipts while refresh activation remains disabled.
    await flushWebsiteRefreshUsageOutbox(env, now);
    await env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_schedules SET enabled=0,generation=generation+1,next_run_at=NULL,
      last_result='paused',last_error_code='schedule_rollout_disabled',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE enabled=1`)
      .bind(now.toISOString()).run();
    return { selected: 0, claimed: 0, completed: 0, failed: 0, paused: 0 };
  }
  const nowIso = now.toISOString();
  const due = await env.PLATFORM_DB.prepare(`SELECT rs.id AS schedule_id,rs.tenant_id,rs.space_id,rs.project_id,
      rs.document_id,rs.connection_ref,rs.owner_user_id,rs.enabled,rs.interval_hours,rs.generation,
      rs.next_run_at AS due_at,rs.failure_count,rs.lease_expires_at,d.status AS document_status,d.source_adapter,
      d.source_state,d.source_revision,d.source_url,d.source_requested_url,d.source_content_sha256,d.title,
      d.source_connection_ref AS document_connection_ref,wc.status AS connection_status,wc.owner_user_id AS connection_owner_user_id,
      pa.role_rank AS project_role_rank
    FROM kb_source_refresh_schedules rs
    LEFT JOIN kb_documents d ON d.id=rs.document_id AND d.tenant_id=rs.tenant_id AND d.space_id=rs.space_id AND d.project_id=rs.project_id
    LEFT JOIN website_connections wc ON wc.id=rs.connection_ref AND wc.tenant_id=rs.tenant_id
      AND wc.space_id=rs.space_id AND wc.project_id=rs.project_id
    LEFT JOIN project_access pa ON pa.project_id=rs.project_id AND pa.tenant_id=rs.tenant_id AND pa.space_id=rs.space_id
      AND pa.user_id=rs.owner_user_id
    WHERE rs.enabled=1 AND rs.next_run_at<=? AND (rs.lease_token IS NULL OR rs.lease_expires_at<=?)
    ORDER BY rs.next_run_at,rs.id LIMIT ${SCHEDULE_BATCH_LIMIT}`)
    .bind(nowIso, nowIso).all<DueWebsiteRefresh>();
  const result: ScheduledRefreshRunResult = { selected: due.results.length, claimed: 0, completed: 0, failed: 0, paused: 0 };
  for (const schedule of due.results) {
    const sourceIsCurrent = schedule.document_status === "indexed" || schedule.document_status === "failed";
    const connectionInactive = !schedule.connection_status || schedule.connection_status !== "active";
    const ownerRoleInvalid = (schedule.project_role_rank ?? -1) < 40;
    if (!schedule.document_status || schedule.source_adapter !== "website" || schedule.source_state !== "current"
      || schedule.document_connection_ref !== schedule.connection_ref || connectionInactive
      || schedule.connection_owner_user_id !== schedule.owner_user_id || ownerRoleInvalid
      || !schedule.source_url || !schedule.source_requested_url) {
      const code = connectionInactive ? "website_connection_revoked" : ownerRoleInvalid ? "owner_access_changed" : "website_source_unavailable";
      if (await pauseSchedule(env, schedule, now, code)) result.paused++;
      continue;
    }
    if (!sourceIsCurrent) continue;
    const leaseToken = crypto.randomUUID();
    const runId = await refreshKey(schedule);
    const receiptKey = `knowledge-website-refresh:${runId}`;
    const claimed = await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_schedules SET lease_token=?,lease_expires_at=?,updated_at=?
        WHERE id=? AND enabled=1 AND generation=? AND next_run_at=? AND (lease_token IS NULL OR lease_expires_at<=?)`)
        .bind(leaseToken, new Date(now.getTime() + SCHEDULE_LEASE_MS).toISOString(), nowIso,
          schedule.schedule_id, schedule.generation, schedule.due_at, nowIso),
      env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO kb_website_refresh_usage_outbox
        (run_id,tenant_id,space_id,project_id,idempotency_key,created_at,updated_at)
        SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM kb_source_refresh_schedules
          WHERE id=? AND enabled=1 AND generation=? AND lease_token=?)`)
        .bind(runId, schedule.tenant_id, schedule.space_id, schedule.project_id, receiptKey, nowIso, nowIso,
          schedule.schedule_id, schedule.generation, leaseToken),
    ]);
    if (!Number(claimed[0]?.meta.changes ?? 0)) continue;
    result.claimed++;
    try {
      const token = await mintInternalToken(env.PLATFORM_SECRET, schedule.tenant_id);
      const headers = new Headers({ "content-type": "application/json", "x-naelao-tenant-id": schedule.tenant_id,
        "x-naelao-user-id": schedule.owner_user_id, "x-naelao-role": "product_end_user", "x-naelao-internal-token": token });
      const commonPath = "/spaces/" + encodeURIComponent(schedule.space_id) + "/kb";
      const previewResponse = await fetchInternal(new Request("https://knowledge.internal" + commonPath
        + "/projects/" + encodeURIComponent(schedule.project_id) + "/sources/website/preview", {
          method: "POST", headers, body: JSON.stringify({ document_id: schedule.document_id,
            idempotency_key: runId, url: schedule.source_requested_url }),
        }), env, ctx);
      const previewBody = await safeJson(previewResponse);
      if (!previewResponse.ok || !previewBody.preview || typeof previewBody.preview !== "object") {
        const retryAt = typeof previewBody.retry_at === "string" ? previewBody.retry_at : undefined;
        const code = errorCodeFrom(previewBody);
        if (["forbidden", "website_connection_not_found", "website_source_not_refreshable", "project_not_found"].includes(code)) {
          if (await pauseSchedule(env, schedule, now, code === "forbidden" ? "owner_access_changed" : code)) result.paused++;
        } else if (await recordFailure(env, schedule, leaseToken, now, code, retryAt)) result.failed++;
        continue;
      }
      const preview = previewBody.preview as SchedulePreview;
      if (typeof preview.content !== "string" || preview.content.length === 0 || preview.content.length > 1_048_576
        || preview.expected_source_revision !== schedule.source_revision || typeof preview.preview_sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(preview.preview_sha256) || typeof preview.refresh_operation_id !== "string"
        || typeof preview.preview_token !== "string" || typeof preview.final_url !== "string" || typeof preview.requested_url !== "string") {
        if (await recordFailure(env, schedule, leaseToken, now, "website_refresh_receipt_invalid")) result.failed++;
        continue;
      }
      if (schedule.source_content_sha256 === preview.preview_sha256) {
        if (await finishUnchanged(env, schedule, leaseToken, preview, now)) result.completed++;
        else if (await recordFailure(env, schedule, leaseToken, now, "website_refresh_superseded")) result.failed++;
        continue;
      }
      const updateResponse = await fetchInternal(new Request("https://knowledge.internal" + commonPath
        + "/documents/" + encodeURIComponent(schedule.document_id), {
          method: "PATCH", headers, body: JSON.stringify({ title: schedule.title, content: preview.content,
            website_refresh: { operation_id: preview.refresh_operation_id, expected_source_revision: preview.expected_source_revision,
              requested_url: preview.requested_url, final_url: preview.final_url, preview_sha256: preview.preview_sha256,
              preview_token: preview.preview_token },
            scheduled_refresh: { schedule_id: schedule.schedule_id, lease_token: leaseToken, generation: schedule.generation },
          }),
        }), env, ctx);
      if (updateResponse.ok) result.completed++;
      else if (await recordFailure(env, schedule, leaseToken, now, errorCodeFrom(await safeJson(updateResponse)))) result.failed++;
    } catch {
      if (await recordFailure(env, schedule, leaseToken, now, "website_refresh_unavailable")) result.failed++;
    }
  }
  await flushWebsiteRefreshUsageOutbox(env, now);
  return result;
}
