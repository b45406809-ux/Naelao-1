-- Explicitly selected private files may be stored in an independent encrypted recovery object.
-- The empty default manifest and missing runtime bindings keep this feature unavailable until
-- keys, jurisdiction-specific storage, quotas and retention are configured and verified.
CREATE TABLE IF NOT EXISTS project_main_private_state_manifests (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  paths_json TEXT NOT NULL CHECK(length(paths_json) <= 8192),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,space_id,project_id)
);

CREATE TABLE IF NOT EXISTS project_main_private_state_manifest_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  previous_version INTEGER NOT NULL CHECK(previous_version >= 0),
  new_version INTEGER NOT NULL CHECK(new_version > previous_version),
  path_count INTEGER NOT NULL CHECK(path_count BETWEEN 0 AND 20),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id,space_id,project_id,new_version)
);

CREATE TABLE IF NOT EXISTS project_main_private_state_backups (
  backup_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  jurisdiction TEXT NOT NULL CHECK(jurisdiction IN ('global','eu')),
  allocation_generation INTEGER NOT NULL CHECK(allocation_generation >= 0),
  image_fingerprint TEXT NOT NULL CHECK(length(image_fingerprint) = 64),
  toolchain_fingerprint TEXT NOT NULL CHECK(length(toolchain_fingerprint) = 64),
  key_version TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  ciphertext_bytes INTEGER NOT NULL CHECK(ciphertext_bytes > 0),
  file_count INTEGER NOT NULL CHECK(file_count BETWEEN 1 AND 20),
  state TEXT NOT NULL CHECK(state IN ('available','expired','erasure_notified','delete_pending','deleted')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(tenant_id,space_id,project_id,request_id)
);
CREATE INDEX IF NOT EXISTS idx_project_main_private_state_backups_due
  ON project_main_private_state_backups(state,expires_at);
CREATE INDEX IF NOT EXISTS idx_project_main_private_state_backups_scope
  ON project_main_private_state_backups(tenant_id,space_id,project_id,created_at);
