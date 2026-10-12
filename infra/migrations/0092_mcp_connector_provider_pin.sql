-- A workspace can have at most one provider-backed row per connector name. This makes the
-- provider choice durable under concurrent connect callbacks; changing providers requires
-- deleting the existing row and reconnecting explicitly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_provider_pin
  ON mcp_servers (space_id, tenant_id, name)
  WHERE connector_provider IN ('composio', 'pipedream');
