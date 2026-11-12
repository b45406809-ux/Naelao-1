-- User-selected Cloudflare main-computer resource profile. The deployed provider and image
-- remain host-controlled; only an approved size key is stored here.
CREATE TABLE IF NOT EXISTS project_main_runtime_profiles (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  profile TEXT NOT NULL CHECK(profile IN ('lite','standard-1','standard-2','standard-3','standard-4')),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,space_id,project_id)
);

CREATE TABLE IF NOT EXISTS project_main_runtime_profile_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  previous_profile TEXT,
  new_profile TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_main_runtime_profile_audit_scope
  ON project_main_runtime_profile_audit(tenant_id,space_id,project_id,created_at);
