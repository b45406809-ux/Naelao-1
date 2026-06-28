-- G-MCP01..MCP05: MCP (Model Context Protocol) server registry
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  transport TEXT NOT NULL DEFAULT 'stdio',  -- 'stdio', 'http', 'sse'
  url TEXT,                                  -- for http/sse transport
  command TEXT,                              -- for stdio transport
  args_json TEXT,                            -- JSON array of command args
  env_json TEXT,                             -- JSON object of env vars (refs to credentials)
  enabled INTEGER NOT NULL DEFAULT 1,
  last_connected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_space ON mcp_servers (space_id, enabled);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_tenant ON mcp_servers (tenant_id);
