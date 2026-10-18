CREATE TABLE IF NOT EXISTS project_steward_decisions (
  decision_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  review_key TEXT NOT NULL,
  recommendation TEXT NOT NULL CHECK (recommendation IN ('inspect_routine','review_blocked_work','owner_check_in')),
  action TEXT NOT NULL CHECK (action IN ('acknowledge','snooze','dismiss')),
  actor_id TEXT NOT NULL,
  note TEXT,
  snoozed_until INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (space_id, project_id, review_key)
);

CREATE INDEX IF NOT EXISTS idx_project_steward_decisions_scope
  ON project_steward_decisions(tenant_id, space_id, project_id, created_at DESC);
