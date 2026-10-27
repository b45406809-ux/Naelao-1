CREATE TABLE IF NOT EXISTS space_blackboard_requests (
  tenant_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL, source_project_id TEXT NOT NULL, target_project_id TEXT NOT NULL,
  objective TEXT NOT NULL, expected_result TEXT NOT NULL, deadline TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','completed','cancelled')),
  response TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,space_id,id)
);
CREATE INDEX IF NOT EXISTS space_blackboard_requests_source ON space_blackboard_requests(tenant_id,space_id,source_project_id,updated_at);
CREATE INDEX IF NOT EXISTS space_blackboard_requests_target ON space_blackboard_requests(tenant_id,space_id,target_project_id,updated_at);
