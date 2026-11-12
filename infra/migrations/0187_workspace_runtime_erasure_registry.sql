-- Inventory runtime Durable Objects that have touched a project workspace so erasure can
-- notify the exact object and clear its private snapshot/cache before canonical cleanup ends.
CREATE TABLE IF NOT EXISTS workspace_runtime_registry (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('tool_sandbox','dynamic_sandbox','document_sandbox','media_sandbox')),
  object_name TEXT NOT NULL CHECK(length(object_name) BETWEEN 1 AND 1024),
  branch TEXT NOT NULL DEFAULT '',
  installation_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  erasure_notified_at TEXT,
  erasure_attempts INTEGER NOT NULL DEFAULT 0,
  last_erasure_error TEXT,
  PRIMARY KEY(tenant_id,space_id,project_id,runtime_kind,object_name)
);
CREATE INDEX IF NOT EXISTS idx_workspace_runtime_erasure
  ON workspace_runtime_registry(tenant_id,space_id,project_id,erasure_notified_at,last_seen_at);
