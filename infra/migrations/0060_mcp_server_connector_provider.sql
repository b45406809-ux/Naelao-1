-- Phase P: Composio/Pipedream connector provider support.
-- Adds a connector_provider column to mcp_servers so a registered server can be routed
-- through a gateway provider (Composio, Pipedream) instead of called directly.
-- 'direct' (default) = current behaviour: call server.url/mcp directly.
-- 'composio' = route through Composio's execute-action API using the stored connection_id.
-- 'pipedream' = route through Pipedream Connect using the stored connection_id.
-- Also adds connector_id to capture the provider's opaque connection reference (never the OAuth token).
ALTER TABLE mcp_servers ADD COLUMN connector_provider TEXT NOT NULL DEFAULT 'direct'
  CHECK (connector_provider IN ('direct', 'composio', 'pipedream'));
ALTER TABLE mcp_servers ADD COLUMN provider_connection_id TEXT;
CREATE INDEX IF NOT EXISTS idx_mcp_servers_provider ON mcp_servers (space_id, connector_provider);
