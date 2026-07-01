-- Time-based scheduling (spec §05 "cron-jobs.json — the assistant's schedule of recurring
-- tasks"), the no-code-configurable equivalent for a builder: "every day at 9am, run this
-- script." Complements event_triggers (SpaceDO, event-driven: thread.created/project.created/
-- ...) with a TIME-driven trigger. Lives in PLATFORM_DB (not SpaceDO SQLite) for the same
-- reason channel_links does: the hourly dispatcher needs one cheap cross-space query to find
-- everything due, rather than waking every space's SpaceDO just to ask "do you have anything
-- due" (see runScheduledJobs, workers/agents/src/index.ts).
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id              TEXT PRIMARY KEY,
  space_id        TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  project_id      TEXT, -- NULL = space-wide (fires against the Space Assistant's workspace)
  name            TEXT NOT NULL,
  cron_expression TEXT NOT NULL, -- 5-field ("minute hour day-of-month month day-of-week"), UTC
  script_name     TEXT NOT NULL, -- the script.run action fired on schedule
  params          TEXT NOT NULL DEFAULT '{}', -- JSON, passed to the fired script
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_at     INTEGER, -- unix ms; NULL = never run (isCronDue scans from created_at instead)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_dispatch ON scheduled_jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_space ON scheduled_jobs(space_id);
