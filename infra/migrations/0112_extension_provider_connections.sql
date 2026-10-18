CREATE TABLE IF NOT EXISTS extension_provider_connections (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_label TEXT,
  credential_name TEXT NOT NULL,
  handler_sha256 TEXT,
  granted_scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','revoked','error')),
  connected_by TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  last_verified_at TEXT,
  revoked_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,space_id,installation_id,connection_id),
  UNIQUE(tenant_id,space_id,credential_name)
);

CREATE INDEX IF NOT EXISTS idx_extension_provider_connections_account
  ON extension_provider_connections(tenant_id,space_id,provider,account_id,status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_provider_connections_active_account
  ON extension_provider_connections(tenant_id,space_id,provider,account_id) WHERE status='active';

CREATE INDEX IF NOT EXISTS idx_extension_provider_connections_project
  ON extension_provider_connections(tenant_id,space_id,project_id,installation_id,status);
