-- Separate credential reachability from runtime/capability acceptance. A valid control-plane
-- key alone must never mark a template or execution runtime as verified.
ALTER TABLE sandbox_connections ADD COLUMN control_plane_verified_at TEXT;
ALTER TABLE sandbox_connections ADD COLUMN credential_check_status TEXT NOT NULL DEFAULT 'not_checked'
  CHECK(credential_check_status IN ('not_checked','verified','failed'));
ALTER TABLE sandbox_connections ADD COLUMN credential_check_error_code TEXT;

CREATE INDEX IF NOT EXISTS idx_sandbox_connections_credential_check
  ON sandbox_connections(tenant_id, owner_id, credential_check_status, updated_at);
