CREATE TABLE IF NOT EXISTS space_blackboard_policies (
  tenant_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL, wake_enabled INTEGER NOT NULL DEFAULT 0 CHECK(wake_enabled IN (0,1)),
  authorized_user_id TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,space_id,project_id)
);
CREATE TABLE IF NOT EXISTS space_blackboard_wakes (
  tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT NOT NULL, event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','held')),
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, lease_until INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY(tenant_id,space_id,project_id,event_id),
  FOREIGN KEY(tenant_id,space_id,event_id,project_id) REFERENCES space_blackboard_events(tenant_id,space_id,event_id,project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS space_blackboard_wakes_due ON space_blackboard_wakes(status,next_at,lease_until);
