-- Give project assistants their own inbound alias and route context. Keep the existing
-- agent_email_addresses table intact so provisioned Space assistant addresses remain valid.
CREATE TABLE IF NOT EXISTS project_agent_email_addresses (
  address_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, space_id, agent_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_agent_email_addresses_scope
  ON project_agent_email_addresses(tenant_id, space_id, project_id, agent_id, status);
