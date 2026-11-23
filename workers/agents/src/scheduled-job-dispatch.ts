import { SCHEDULED_JOB_RUN_HISTORY_LIMIT } from "./scheduled-job-constants.js";

const SCHEDULED_JOB_DISPATCH_LEASE_MS = 30 * 60 * 1000;
const SCHEDULED_JOB_DISPATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type ScheduledJobDispatchTerminalStatus = "completed" | "failed" | "skipped" | "outcome_unknown";

/** Stable identity for one owner-configured scheduled intent and a retry-safe run receipt. This
 * is attribution and idempotency context; effect authorization still comes from current host
 * Project, agent-policy, installation and billing checks. */
export function scheduledJobExecutionIdentity(input: { jobId: string; revision: string; sweepKey: number }): {
  serviceIdentityId: string; authorizationRevision: string; runId: string;
} {
  return {
    serviceIdentityId: `scheduled_job:${input.jobId}`,
    authorizationRevision: input.revision,
    runId: `scheduled-job:${input.jobId}:${input.sweepKey}`,
  };
}

/** Claim one due job in one hourly sweep. The primary key deduplicates queue redelivery; the
 * lease prevents separate sweeps from overlapping while the same job is still being dispatched.
 * Returning null means the job was paused/deleted, already claimed in this sweep, or another
 * execution still owns its lease. */
export async function claimScheduledJobDispatch(
  db: D1Database,
  input: { jobId: string; sweepKey: number; now?: number },
): Promise<string | null> {
  const now = input.now ?? Date.now();
  try {
    await db.prepare(`DELETE FROM scheduled_job_dispatches
      WHERE updated_at < ? AND status NOT IN ('running', 'outcome_unknown')`)
      .bind(now - SCHEDULED_JOB_DISPATCH_RETENTION_MS).run();
  } catch { /* retention is best-effort; claim safety is enforced by the following unique insert */ }

  const token = crypto.randomUUID();
  const row = await db.prepare(
    `INSERT INTO scheduled_job_dispatches
       (job_id, sweep_key, claim_token, status, lease_until, created_at, updated_at)
     SELECT ?, ?, ?, 'running', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM scheduled_jobs WHERE id = ? AND enabled = 1)
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_job_dispatches
           WHERE job_id = ? AND (status = 'outcome_unknown' OR (status = 'running' AND lease_until > ?))
        )
     ON CONFLICT(job_id, sweep_key) DO NOTHING
     RETURNING claim_token`,
  ).bind(
    input.jobId, input.sweepKey, token, now + SCHEDULED_JOB_DISPATCH_LEASE_MS, now, now,
    input.jobId, input.jobId, now,
  ).first<{ claim_token: string }>();
  return row?.claim_token ?? null;
}

/** Persist the exact scheduled run and receipt as an unknown outcome before entering the
 * direct-script call. A process loss from this point forward must block later sweeps. */
export async function markScheduledJobDispatchOutcomeUnknown(
  db: D1Database,
  input: { jobId: string; sweepKey: number; claimToken: string; runId: string; attemptReceipt: string;
    spaceId: string; tenantId: string; projectId: string; firedAt: number; now?: number },
): Promise<void> {
  const now = input.now ?? Date.now();
  const results = await db.batch([
    db.prepare(
      `UPDATE scheduled_job_dispatches
          SET status = 'outcome_unknown', lease_until = 0, run_id = ?, attempt_receipt = ?, updated_at = ?
        WHERE job_id = ? AND sweep_key = ? AND claim_token = ? AND status = 'running'`,
    ).bind(input.runId, input.attemptReceipt, now, input.jobId, input.sweepKey, input.claimToken),
    db.prepare(
      `INSERT INTO scheduled_job_runs
         (id, job_id, space_id, tenant_id, project_id, fired_at, ok, error, duration_ms, skipped_busy,
          run_id, outcome_status, attempt_receipt)
       SELECT ?, ?, ?, ?, ?, ?, 0, 'direct_script_result_pending', NULL, 0, ?, 'outcome_unknown', ?
        WHERE EXISTS (
          SELECT 1 FROM scheduled_job_dispatches
           WHERE job_id = ? AND sweep_key = ? AND claim_token = ? AND run_id = ? AND status = 'outcome_unknown'
        )`,
    ).bind(crypto.randomUUID(), input.jobId, input.spaceId, input.tenantId, input.projectId, input.firedAt,
      input.runId, input.attemptReceipt, input.jobId, input.sweepKey, input.claimToken, input.runId),
    db.prepare(
      `DELETE FROM scheduled_job_runs WHERE job_id = ? AND outcome_status != 'outcome_unknown' AND id NOT IN (
         SELECT id FROM scheduled_job_runs WHERE job_id = ? ORDER BY fired_at DESC LIMIT ?
       )`,
    ).bind(input.jobId, input.jobId, SCHEDULED_JOB_RUN_HISTORY_LIMIT),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1)
    throw new Error("scheduled_job_dispatch_claim_lost_before_effect");
}

/** Revalidate the exact owner-configured wake after acquiring its queue lease. An administrator
 * may pause, delete, retarget, or edit a job between the initial due-row read and the effect.
 * The lease is not permission to execute an older action snapshot. This narrows that window; it
 * does not claim to cancel an effect already in flight after this check. */
export async function scheduledJobDispatchSnapshotCurrent(
  db: D1Database,
  input: {
    jobId: string; spaceId: string; tenantId: string; updatedAt: string; projectId: string;
    cronExpression: string; scriptName: string; params: string; agentId: string | null; goal: string | null;
    quietHoursStart: string | null; quietHoursEnd: string | null; quietHoursTimezone: string;
  },
): Promise<boolean> {
  const current = await db.prepare(`SELECT 1 AS current FROM scheduled_jobs
    WHERE id=? AND space_id=? AND tenant_id=? AND enabled=1 AND updated_at=? AND project_id=?
      AND cron_expression=? AND script_name=? AND params=? AND agent_id IS ? AND goal IS ?
      AND quiet_hours_start IS ? AND quiet_hours_end IS ? AND quiet_hours_timezone=? LIMIT 1`)
    .bind(input.jobId, input.spaceId, input.tenantId, input.updatedAt, input.projectId, input.cronExpression,
      input.scriptName, input.params, input.agentId, input.goal, input.quietHoursStart, input.quietHoursEnd,
      input.quietHoursTimezone).first<{ current: number }>();
  return current?.current === 1;
}

/** Mark a claim terminal before allowing later sweeps to proceed. A duplicate delivery for the
 * same sweep remains deduplicated by its primary key even after this status update. */
export async function releaseScheduledJobDispatch(
  db: D1Database,
  input: { jobId: string; sweepKey: number; claimToken: string; status: ScheduledJobDispatchTerminalStatus;
    runId?: string; attemptReceipt?: string; now?: number },
): Promise<void> {
  const now = input.now ?? Date.now();
  await db.prepare(
    `UPDATE scheduled_job_dispatches
        SET status = ?, lease_until = 0, run_id = COALESCE(?, run_id),
            attempt_receipt = COALESCE(?, attempt_receipt), updated_at = ?
      WHERE job_id = ? AND sweep_key = ? AND claim_token = ? AND status IN ('running', 'outcome_unknown')`,
  ).bind(input.status, input.runId ?? null, input.attemptReceipt ?? null, now, input.jobId, input.sweepKey, input.claimToken).run();
}
