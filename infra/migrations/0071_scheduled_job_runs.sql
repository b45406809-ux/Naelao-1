-- Phase 3 item 27/28 — scheduled_jobs has last_run_at/consecutive_failures (the CURRENT state)
-- but no per-fire HISTORY: nothing records what happened on each individual attempt, so a Crons
-- editing UI could show "when did this last run" but never "how has it been going" (a list of
-- recent fires, each pass/fail, with the real error). Same PLATFORM_DB table as scheduled_jobs
-- itself (the hourly dispatcher already needs one cheap cross-space query there — see that
-- migration's own comment for why this isn't per-space SpaceDO state).
--
-- Deliberately a flat append-only log, not a column on scheduled_jobs: a job fires repeatedly
-- over its lifetime and each fire is its own fact, not a value to overwrite.
CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  space_id    TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  fired_at    INTEGER NOT NULL, -- unix ms, matches scheduled_jobs.last_run_at's own unit
  ok          INTEGER NOT NULL, -- 1 = succeeded, 0 = failed
  error       TEXT,             -- NULL on success
  duration_ms INTEGER,          -- NULL when unknown (a skip is never recorded here at all)
  skipped_busy INTEGER NOT NULL DEFAULT 0 -- was this fire skipped because the assistant was
                                          -- still running a prior wake? Recorded here (not in
                                          -- scheduled_jobs' own last_run_at/consecutive_failures,
                                          -- which are deliberately left untouched by a skip) so a
                                          -- run-history UI can still show it happened, distinct
                                          -- from a genuine pass or fail.
);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job ON scheduled_job_runs(job_id, fired_at DESC);
-- Retention: unbounded growth for an hourly-or-more-frequent job is a real concern at scale.
-- The write path (recordScheduledJobRun, workers/agents) caps what it keeps per job rather than
-- relying on a separate cleanup job — see that function's own comment.
