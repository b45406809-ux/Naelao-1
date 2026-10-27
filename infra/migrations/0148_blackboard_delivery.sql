CREATE TABLE IF NOT EXISTS space_blackboard_delivery (
  tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT NOT NULL,
  event_id TEXT NOT NULL, identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','running','delegated')),
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, lease_until INTEGER,
  PRIMARY KEY(tenant_id,space_id,project_id,event_id,identity_id),
  FOREIGN KEY(tenant_id,space_id,event_id,project_id)
    REFERENCES space_blackboard_events(tenant_id,space_id,event_id,project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS space_blackboard_delivery_due ON space_blackboard_delivery(status,next_at,lease_until);
