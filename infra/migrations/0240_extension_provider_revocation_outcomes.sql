-- Keep local extension access revoked while tracking external provider cleanup that may fail.
-- This ledger stores identifiers and outcome codes only, never provider credentials or payloads.
CREATE TABLE IF NOT EXISTS extension_provider_revocation_outcomes (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','complete','not_supported')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_attempt_at TEXT,
  action_code TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(tenant_id,space_id,installation_id,connection_id)
);

CREATE INDEX IF NOT EXISTS idx_extension_provider_revocation_project_status
  ON extension_provider_revocation_outcomes(tenant_id,space_id,project_id,status,updated_at DESC);
