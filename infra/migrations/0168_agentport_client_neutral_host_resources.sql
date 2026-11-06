-- Host resource identifiers are opaque to AgentPort. Preserve legacy host_space_id values while
-- migrating identities to the client-neutral contract consumed by external platforms.
ALTER TABLE agentport_agents ADD COLUMN host_resource_id TEXT;
UPDATE agentport_agents SET host_resource_id=host_space_id WHERE host_resource_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_agentport_agents_host_resource
  ON agentport_agents(tenant_id, host_platform, host_resource_id, status);

-- Generalize the first-party host marker without changing the tenant's organization identity.
UPDATE agentport_organizations
  SET owner_developer_id=REPLACE(owner_developer_id,'naelao-managed:','platform-managed:')
  WHERE owner_developer_id LIKE 'naelao-managed:%';
