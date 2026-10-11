-- A credential can be shared by a whole space or isolated to one project. The legacy
-- `scope` column remains `space` for project credentials to preserve old readers; project_id
-- gives the credential vault a separate ownership boundary and a distinct uniqueness key.
ALTER TABLE space_credentials ADD COLUMN project_id TEXT;

DROP INDEX IF EXISTS idx_space_credentials_space;
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_credentials_space
  ON space_credentials(space_id, name) WHERE scope = 'space' AND project_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_credentials_project
  ON space_credentials(space_id, project_id, name) WHERE scope = 'space' AND project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_credentials_project_lookup
  ON space_credentials(tenant_id, space_id, project_id, name) WHERE project_id IS NOT NULL;

-- Random per-space AES-256 data keys are stored only in wrapped form. The active version of
-- CREDENTIAL_ENCRYPTION_KEY wraps the DEK through a tenant+space HKDF-derived KEK.
CREATE TABLE IF NOT EXISTS space_credential_keys (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  key_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, space_id)
);
