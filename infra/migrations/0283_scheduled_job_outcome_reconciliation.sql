-- Preserve an exact receipt when a scheduled direct script may have started but its result
-- cannot be established. Unknown dispatches are durable job-wide retry blockers until an
-- authorized reconciliation records what was verified.
DROP INDEX IF EXISTS idx_scheduled_job_dispatches_active;
DROP INDEX IF EXISTS idx_scheduled_job_dispatches_retention;
ALTER TABLE scheduled_job_dispatches RENAME TO scheduled_job_dispatches_v283;

CREATE TABLE scheduled_job_dispatches (
  job_id TEXT NOT NULL,
  sweep_key INTEGER NOT NULL,
  claim_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'running','completed','failed','skipped','outcome_unknown',
    'reconciled_completed','reconciled_no_effect'
  )),
  lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  run_id TEXT,
  attempt_receipt TEXT,
  resolved_at INTEGER,
  resolved_by TEXT,
  resolution_note TEXT,
  PRIMARY KEY (job_id, sweep_key)
);
INSERT INTO scheduled_job_dispatches
  (job_id, sweep_key, claim_token, status, lease_until, created_at, updated_at)
SELECT job_id, sweep_key, claim_token, status, lease_until, created_at, updated_at
  FROM scheduled_job_dispatches_v283;
DROP TABLE scheduled_job_dispatches_v283;
CREATE INDEX idx_scheduled_job_dispatches_active
  ON scheduled_job_dispatches(job_id, status, lease_until);
CREATE INDEX idx_scheduled_job_dispatches_retention
  ON scheduled_job_dispatches(updated_at);
CREATE INDEX idx_scheduled_job_dispatches_unknown
  ON scheduled_job_dispatches(job_id, status) WHERE status = 'outcome_unknown';

ALTER TABLE scheduled_job_runs ADD COLUMN run_id TEXT;
ALTER TABLE scheduled_job_runs ADD COLUMN outcome_status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE scheduled_job_runs ADD COLUMN attempt_receipt TEXT;
ALTER TABLE scheduled_job_runs ADD COLUMN resolved_at INTEGER;
ALTER TABLE scheduled_job_runs ADD COLUMN resolved_by TEXT;
ALTER TABLE scheduled_job_runs ADD COLUMN resolution_note TEXT;
UPDATE scheduled_job_runs
   SET outcome_status = CASE
     WHEN skipped_busy = 1 THEN 'skipped'
     WHEN ok = 1 THEN 'completed'
     ELSE 'failed'
   END;
CREATE UNIQUE INDEX idx_scheduled_job_runs_run_id
  ON scheduled_job_runs(run_id) WHERE run_id IS NOT NULL;
