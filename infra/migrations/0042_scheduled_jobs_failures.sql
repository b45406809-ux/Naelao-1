-- Failure tracking for scheduled_jobs (0041) — a job whose script 404s/500s used to refire
-- every hour forever, because last_run_at was only ever written on success (the same due
-- minute got re-attempted on every sweep). consecutive_failures + last_error let the
-- dispatcher (workers/agents/src/index.ts runScheduledJobs) record a failed attempt as
-- "consumed" (still advances last_run_at) and auto-disable after repeated failures instead of
-- retrying forever.
ALTER TABLE scheduled_jobs ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_jobs ADD COLUMN last_error TEXT;

-- The dispatch query filters enabled=1 AND joins spaces on space_id — a single-column index
-- on `enabled` alone was never a useful index for that access pattern.
DROP INDEX IF EXISTS idx_scheduled_jobs_dispatch;
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_dispatch ON scheduled_jobs(enabled, space_id);
