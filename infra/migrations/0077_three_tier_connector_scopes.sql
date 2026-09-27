-- Canonical Batch 03 scope names. Rebuild because SQLite cannot alter CHECK constraints.
ALTER TABLE connector_aliases RENAME TO connector_aliases_legacy;

CREATE TABLE connector_aliases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('space_shared','project_bound','user_personal')),
  project_id TEXT,
  user_id TEXT,
  server_id TEXT NOT NULL,
  granted_scopes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE,
  CHECK ((scope='space_shared' AND project_id IS NULL AND user_id IS NULL)
    OR (scope='project_bound' AND project_id IS NOT NULL AND user_id IS NULL)
    OR (scope='user_personal' AND project_id IS NULL AND user_id IS NOT NULL))
);

INSERT INTO connector_aliases
SELECT id, tenant_id, space_id, alias,
  CASE scope WHEN 'space' THEN 'space_shared' WHEN 'project' THEN 'project_bound'
    WHEN 'user' THEN 'user_personal' ELSE scope END,
  project_id, user_id, server_id, granted_scopes_json, created_at, updated_at
FROM connector_aliases_legacy;
DROP TABLE connector_aliases_legacy;

CREATE UNIQUE INDEX idx_connector_alias_scope
  ON connector_aliases(tenant_id, space_id, alias, scope, ifnull(project_id,''), ifnull(user_id,''));
CREATE INDEX idx_connector_alias_resolve
  ON connector_aliases(tenant_id, space_id, alias, user_id, project_id);
