CREATE TABLE IF NOT EXISTS space_blackboard_events (
  tenant_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL, project_id TEXT NOT NULL, request_id TEXT NOT NULL,
  kind TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,space_id,event_id,project_id)
);
CREATE INDEX IF NOT EXISTS space_blackboard_events_inbox ON space_blackboard_events(tenant_id,space_id,project_id,created_at,event_id);
