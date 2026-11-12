-- Persist the exact project-scoped encrypted browser profile objects so project erasure can
-- revoke and cancel them without enumerating Durable Object namespaces.
CREATE TABLE IF NOT EXISTS workspace_browser_profile_registry (
  profile_id TEXT PRIMARY KEY CHECK(length(profile_id)=64 AND profile_id NOT GLOB '*[^a-f0-9]*'),
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  erasure_notified_at TEXT,
  erasure_attempts INTEGER NOT NULL DEFAULT 0,
  last_erasure_error TEXT,
  UNIQUE(tenant_id,space_id,project_id,actor_id,connection_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_browser_profile_erasure
  ON workspace_browser_profile_registry(tenant_id,space_id,project_id,erasure_notified_at,last_seen_at);
