-- Read state is per member; one member acknowledging an event cannot hide it from another.
CREATE TABLE IF NOT EXISTS space_blackboard_event_receipts (
  tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT NOT NULL,
  event_id TEXT NOT NULL, user_id TEXT NOT NULL, read_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,space_id,project_id,event_id,user_id),
  FOREIGN KEY(tenant_id,space_id,event_id,project_id)
    REFERENCES space_blackboard_events(tenant_id,space_id,event_id,project_id) ON DELETE CASCADE
);
