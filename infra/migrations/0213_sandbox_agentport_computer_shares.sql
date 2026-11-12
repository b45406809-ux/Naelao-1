-- Owner-consented, per-computer AgentPort grants for customer-owned Agent37 resources.
CREATE TABLE IF NOT EXISTS sandbox_agentport_shares (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  computer_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  agentport_principal_id TEXT NOT NULL,
  agentport_agent_id TEXT NOT NULL,
  agentport_account_id TEXT NOT NULL,
  owner_link_id TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','active','revoking','revoked','unknown')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(tenant_id, computer_id)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_agentport_shares_owner
  ON sandbox_agentport_shares(tenant_id, owner_id, space_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_sandbox_agentport_shares_agent
  ON sandbox_agentport_shares(tenant_id, agentport_agent_id, status);

CREATE TABLE IF NOT EXISTS sandbox_agentport_operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  computer_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('share','revoke')),
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  status TEXT NOT NULL CHECK(status IN ('pending','complete','unknown')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, owner_id, computer_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_agentport_operations_due
  ON sandbox_agentport_operations(status, updated_at);

-- Retain the authorizing AgentPort identity with recoverable provider operations so a later
-- owner-triggered reconciliation cannot silently turn an agent action into an owner bypass.
ALTER TABLE sandbox_operations ADD COLUMN agentport_agent_id TEXT;
ALTER TABLE sandbox_executions ADD COLUMN agentport_agent_id TEXT;
ALTER TABLE sandbox_artifact_transfers ADD COLUMN agentport_agent_id TEXT;
