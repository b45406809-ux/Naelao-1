-- Owner-selected Naelao assistant for a linked AgentPort AgentMail subscription.
-- AgentPort identities remain provider identities and are never used as Naelao runtime IDs.
ALTER TABLE assistant_agentport_event_runs ADD COLUMN target_assistant_id TEXT;
ALTER TABLE assistant_agentport_event_runs ADD COLUMN target_route_revision INTEGER;

CREATE TABLE IF NOT EXISTS assistant_agentport_event_routes (
  account_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  subscription_id TEXT NOT NULL,
  agentport_agent_id TEXT NOT NULL,
  agentport_account_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  naelao_agent_id TEXT NOT NULL,
  wake_enabled INTEGER NOT NULL DEFAULT 1 CHECK(wake_enabled IN (0,1)),
  route_revision INTEGER NOT NULL DEFAULT 1 CHECK(route_revision > 0),
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  selected_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY(account_id) REFERENCES assistant_agentmail_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_event_routes_scope
  ON assistant_agentport_event_routes(tenant_id,space_id,project_id,status);
