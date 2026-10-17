-- A queue message can be delivered more than once, including while its first delivery is still
-- running. Keep one claim per job and hourly sweep, and a short per-job lease so a stale message
-- cannot start a concurrent execution. Old terminal claims are pruned by the dispatcher.
CREATE TABLE IF NOT EXISTS scheduled_job_dispatches (
  job_id TEXT NOT NULL,
  sweep_key INTEGER NOT NULL,
  claim_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','skipped')),
  lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, sweep_key)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_dispatches_active
  ON scheduled_job_dispatches(job_id, status, lease_until);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_dispatches_retention
  ON scheduled_job_dispatches(updated_at);
