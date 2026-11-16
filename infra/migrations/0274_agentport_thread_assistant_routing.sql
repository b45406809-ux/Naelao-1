ALTER TABLE assistant_agentport_event_runs ADD COLUMN target_route_kind TEXT;
ALTER TABLE assistant_agentport_event_runs ADD COLUMN target_route_key_sha256 TEXT;

-- Runs already pinned by the account-level router keep that original binding.
UPDATE assistant_agentport_event_runs
SET target_route_kind='account'
WHERE target_assistant_id IS NOT NULL AND target_route_kind IS NULL;

CREATE TABLE IF NOT EXISTS assistant_agentport_thread_event_routes (
  account_id TEXT NOT NULL REFERENCES assistant_agentmail_accounts(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  thread_ref_sha256 TEXT NOT NULL CHECK(length(thread_ref_sha256)=64 AND thread_ref_sha256 NOT GLOB '*[^a-f0-9]*'),
  subscription_id TEXT NOT NULL,
  agentport_agent_id TEXT NOT NULL,
  agentport_account_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  naelao_agent_id TEXT NOT NULL,
  wake_enabled INTEGER NOT NULL DEFAULT 1 CHECK(wake_enabled IN (0,1)),
  route_revision INTEGER NOT NULL DEFAULT 1 CHECK(route_revision>0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  selected_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(account_id,thread_ref_sha256)
);

CREATE INDEX IF NOT EXISTS idx_assistant_agentport_thread_routes_scope
  ON assistant_agentport_thread_event_routes(tenant_id,space_id,project_id,account_id,status);
