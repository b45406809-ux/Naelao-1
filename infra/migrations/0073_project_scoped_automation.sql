-- Automation may only be created and billed inside a Launchpad project. Legacy root-level
-- definitions cannot be attributed safely, so migrate by removing them rather than inventing
-- an owner. Rebuild tables because SQLite cannot add NOT NULL to an existing column in place.
DELETE FROM scheduled_job_runs WHERE job_id IN (SELECT id FROM scheduled_jobs WHERE project_id IS NULL);
DELETE FROM scheduled_jobs WHERE project_id IS NULL;

CREATE TABLE scheduled_jobs_v73 (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
  name TEXT NOT NULL, cron_expression TEXT NOT NULL, script_name TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, agent_id TEXT, goal TEXT
);
INSERT INTO scheduled_jobs_v73 SELECT * FROM scheduled_jobs;
DROP TABLE scheduled_jobs;
ALTER TABLE scheduled_jobs_v73 RENAME TO scheduled_jobs;
CREATE INDEX idx_scheduled_jobs_dispatch ON scheduled_jobs(enabled, space_id);
CREATE INDEX idx_scheduled_jobs_space ON scheduled_jobs(space_id);
CREATE INDEX idx_scheduled_jobs_project ON scheduled_jobs(project_id);

CREATE TABLE scheduled_job_runs_v73 (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, space_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL, fired_at INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT,
  duration_ms INTEGER, skipped_busy INTEGER NOT NULL DEFAULT 0
);
INSERT INTO scheduled_job_runs_v73
  SELECT r.id, r.job_id, r.space_id, r.tenant_id, j.project_id, r.fired_at, r.ok, r.error, r.duration_ms, r.skipped_busy
  FROM scheduled_job_runs r JOIN scheduled_jobs j ON j.id = r.job_id;
DROP TABLE scheduled_job_runs;
ALTER TABLE scheduled_job_runs_v73 RENAME TO scheduled_job_runs;
CREATE INDEX idx_scheduled_job_runs_job ON scheduled_job_runs(job_id, fired_at DESC);
CREATE INDEX idx_scheduled_job_runs_project ON scheduled_job_runs(project_id, fired_at DESC);

DELETE FROM triggers;
DROP TABLE triggers;
CREATE TABLE triggers (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
  name TEXT NOT NULL, trigger_type TEXT NOT NULL, cron_expr TEXT, event_type TEXT,
  message_template TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_triggers_space ON triggers(space_id, enabled);
CREATE INDEX idx_triggers_tenant ON triggers(tenant_id);
CREATE INDEX idx_triggers_project ON triggers(project_id, enabled);
