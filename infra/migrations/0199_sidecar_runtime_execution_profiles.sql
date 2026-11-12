-- Owner-controlled execution bounds for approved project sidecars. These settings can only
-- reduce the timeout declared by an installed, deployment-approved container image.
CREATE TABLE IF NOT EXISTS sidecar_runtime_execution_profiles (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  container_id TEXT NOT NULL,
  max_execution_seconds INTEGER NOT NULL CHECK (max_execution_seconds BETWEEN 1 AND 60),
  version INTEGER NOT NULL CHECK (version > 0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, space_id, project_id, installation_id, container_id)
);

CREATE TABLE IF NOT EXISTS sidecar_runtime_execution_profile_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  container_id TEXT NOT NULL,
  previous_max_execution_seconds INTEGER,
  new_max_execution_seconds INTEGER NOT NULL,
  version INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sidecar_runtime_profile_audit_scope
  ON sidecar_runtime_execution_profile_audit(tenant_id, space_id, project_id, installation_id, container_id, created_at);
