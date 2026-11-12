-- Versioned UserPort connector alias links to AgentPort. Provider credentials remain in the
-- existing MCP/Credentials workers. Only selected tool names are kept here, so each AgentPort
-- grant is an exact operation set and MCP Hub can authorize at the real provider call boundary.
CREATE TABLE IF NOT EXISTS agentport_userport_connector_bindings (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  alias_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  owner_link_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('direct','composio','pipedream')),
  provider_connection_sha256 TEXT NOT NULL CHECK (length(provider_connection_sha256)=64),
  service_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  host_resource_id TEXT NOT NULL,
  tool_actions_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','revoked','sync_required')),
  previous_account_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (tenant_id, space_id, alias_id),
  UNIQUE (tenant_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_userport_connector_server
  ON agentport_userport_connector_bindings(tenant_id, space_id, server_id, status);
CREATE INDEX IF NOT EXISTS idx_agentport_userport_connector_owner
  ON agentport_userport_connector_bindings(tenant_id, owner_link_id, status);
