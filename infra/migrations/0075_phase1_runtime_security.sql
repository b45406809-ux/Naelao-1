-- Batches 1-4: durable security/runtime registries shared by edge workers.
CREATE TABLE IF NOT EXISTS connector_aliases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('space','project','user')),
  project_id TEXT,
  user_id TEXT,
  server_id TEXT NOT NULL,
  granted_scopes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE,
  CHECK ((scope='space' AND project_id IS NULL AND user_id IS NULL)
      OR (scope='project' AND project_id IS NOT NULL AND user_id IS NULL)
      OR (scope='user' AND user_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_alias_scope
  ON connector_aliases(tenant_id, space_id, alias, scope, ifnull(project_id,''), ifnull(user_id,''));
CREATE INDEX IF NOT EXISTS idx_connector_alias_resolve
  ON connector_aliases(tenant_id, space_id, alias, user_id, project_id);

CREATE TABLE IF NOT EXISTS capability_nonces (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, space_id, nonce_hash)
);
CREATE INDEX IF NOT EXISTS idx_capability_nonce_expiry ON capability_nonces(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS virtual_cli_commands (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  parser_source TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, space_id, project_id, user_id, name, version)
);
CREATE INDEX IF NOT EXISTS idx_virtual_cli_latest
  ON virtual_cli_commands(tenant_id, space_id, project_id, user_id, name, version DESC);
