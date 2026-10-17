CREATE TABLE IF NOT EXISTS project_steward_runs (
  space_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  last_successful_run_at INTEGER,
  claimed_day TEXT,
  claim_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  report_json TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_steward_runs_claim ON project_steward_runs(claimed_day, lease_until);
