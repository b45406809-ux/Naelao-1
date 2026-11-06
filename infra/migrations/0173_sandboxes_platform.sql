-- Durable external execution resources. Project files stay in the existing workspace R2
-- namespace; these rows contain identities/configuration and provider references only.
CREATE TABLE IF NOT EXISTS sandbox_computers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  space_id TEXT,
  project_id TEXT,
  branch TEXT NOT NULL DEFAULT 'main',
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  ownership TEXT NOT NULL CHECK (ownership IN ('provider_native','customer_owned','naelao_managed','delegated')),
  filesystem_id TEXT NOT NULL,
  filesystem_mode TEXT NOT NULL CHECK (filesystem_mode IN ('snapshot_diff','managed_volume','live_mount')),
  provider_preference TEXT NOT NULL DEFAULT 'auto',
  state TEXT NOT NULL CHECK (state IN ('configured','provisioning','starting','running','syncing','sleeping','stopping','recovery_required','deleting','deleted','error')),
  resources_json TEXT NOT NULL,
  idle_timeout_seconds INTEGER NOT NULL DEFAULT 900 CHECK (idle_timeout_seconds BETWEEN 300 AND 86400),
  allocation_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sandbox_computers_owner ON sandbox_computers(tenant_id,owner_id,state);
CREATE INDEX IF NOT EXISTS idx_sandbox_computers_project ON sandbox_computers(tenant_id,space_id,project_id,branch,state);

CREATE TABLE IF NOT EXISTS sandbox_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('agent37','opensandbox','cloudflare','local','webcontainer')),
  ownership TEXT NOT NULL CHECK (ownership IN ('provider_native','customer_owned','naelao_managed','delegated')),
  status TEXT NOT NULL CHECK (status IN ('configured','configured_unverified','verified','unavailable','revoked')),
  region TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  credential_ciphertext TEXT,
  credential_iv TEXT,
  credential_key_version TEXT NOT NULL DEFAULT 'sandbox-credentials-v1',
  idempotency_key TEXT,
  payload_hash TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_connections_tenant ON sandbox_connections(tenant_id,provider,status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_connections_idempotency ON sandbox_connections(tenant_id,owner_id,idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS sandbox_allocations (
  id TEXT PRIMARY KEY,
  computer_id TEXT NOT NULL REFERENCES sandbox_computers(id),
  connection_id TEXT NOT NULL REFERENCES sandbox_connections(id),
  provider TEXT NOT NULL,
  external_id TEXT,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('intent','active','sleeping','destroyed','unknown','error')),
  endpoint_ciphertext TEXT,
  endpoint_iv TEXT,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(computer_id,generation)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_allocations_external ON sandbox_allocations(provider,external_id,status);

CREATE TABLE IF NOT EXISTS sandbox_filesystems (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  space_id TEXT,
  project_id TEXT,
  branch TEXT NOT NULL DEFAULT 'main',
  mode TEXT NOT NULL CHECK (mode IN ('snapshot_diff','managed_volume','live_mount')),
  consistency TEXT NOT NULL CHECK (consistency IN ('file_cas','exclusive_workspace')),
  status TEXT NOT NULL CHECK (status IN ('active','recovery_required','retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_filesystems_scope ON sandbox_filesystems(tenant_id,space_id,project_id,branch,status);

CREATE TABLE IF NOT EXISTS sandbox_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  computer_id TEXT REFERENCES sandbox_computers(id),
  filesystem_id TEXT REFERENCES sandbox_filesystems(id),
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('user','agent','api_key','agentport_service')),
  grantee_id TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_grants_lookup ON sandbox_grants(tenant_id,grantee_type,grantee_id,revoked_at);

CREATE TABLE IF NOT EXISTS sandbox_operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  computer_id TEXT NOT NULL REFERENCES sandbox_computers(id),
  operation TEXT NOT NULL CHECK (operation IN ('create','start','sleep','delete','sync','recover')),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','complete','failed','indeterminate','conflicted')),
  generation INTEGER NOT NULL,
  error_code TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_operations_pending ON sandbox_operations(status,updated_at);

CREATE TABLE IF NOT EXISTS sandbox_executions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  computer_id TEXT NOT NULL REFERENCES sandbox_computers(id),
  run_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','indeterminate')),
  exit_code INTEGER,
  stdout_ref TEXT,
  stderr_ref TEXT,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  publication_id TEXT,
  workspace_state TEXT NOT NULL DEFAULT 'unchanged' CHECK (workspace_state IN ('unchanged','published','conflicted','recovery_required')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(computer_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_executions_status ON sandbox_executions(tenant_id,computer_id,status,created_at);

CREATE TABLE IF NOT EXISTS sandbox_publications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  filesystem_id TEXT NOT NULL REFERENCES sandbox_filesystems(id),
  computer_id TEXT REFERENCES sandbox_computers(id),
  branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','published','conflicted','recovery_required')),
  changes_json TEXT NOT NULL,
  applied_paths_json TEXT NOT NULL DEFAULT '[]',
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_publications_pending ON sandbox_publications(status,updated_at);

CREATE TABLE IF NOT EXISTS sandbox_usage_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  computer_id TEXT,
  execution_id TEXT,
  connection_id TEXT,
  kind TEXT NOT NULL,
  quantity_micros INTEGER NOT NULL CHECK (quantity_micros >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  rate_version TEXT NOT NULL,
  source_url TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_usage_tenant_time ON sandbox_usage_events(tenant_id,created_at);

CREATE TABLE IF NOT EXISTS sandbox_template_versions (
  template_id TEXT NOT NULL,
  version TEXT NOT NULL,
  digest TEXT NOT NULL,
  provider_constraints_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','verified','deprecated','disabled')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(template_id,version)
);
