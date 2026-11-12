-- Inventory project-scoped browser Durable Objects and screenshot prefixes for project erasure.
CREATE TABLE IF NOT EXISTS workspace_browser_session_registry (
  session_id TEXT PRIMARY KEY CHECK(length(session_id)=64 AND session_id NOT GLOB '*[^a-f0-9]*'),
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  closed_at TEXT,
  erasure_notified_at TEXT,
  erasure_attempts INTEGER NOT NULL DEFAULT 0,
  last_erasure_error TEXT,
  UNIQUE(tenant_id,space_id,project_id,actor_id,agent_id,run_id,browser_session_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_browser_session_erasure
  ON workspace_browser_session_registry(tenant_id,space_id,project_id,erasure_notified_at,closed_at,last_seen_at);
