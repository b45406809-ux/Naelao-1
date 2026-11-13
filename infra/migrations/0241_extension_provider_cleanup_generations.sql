-- Bind cleanup retries to the exact provider credential generation they were created for.
CREATE TABLE IF NOT EXISTS extension_provider_cleanup_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  credential_name TEXT NOT NULL,
  webhook_secret_name TEXT,
  routing_keys_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('pending','complete','not_supported')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_attempt_at TEXT,
  action_code TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_extension_provider_cleanup_project_status
  ON extension_provider_cleanup_operations(tenant_id,space_id,project_id,status,updated_at DESC);

-- The previous receipt key did not distinguish credential rotations. Preserve its history, but
-- require manual reconciliation for any old pending receipt whose exact generation was not saved.
INSERT OR IGNORE INTO extension_provider_cleanup_operations
  (operation_id,tenant_id,space_id,project_id,installation_id,connection_id,provider,account_id,requested_by,
   credential_name,status,attempt_count,last_attempt_at,action_code,last_error_code,created_at,updated_at,completed_at)
SELECT 'legacy:' || tenant_id || ':' || space_id || ':' || installation_id || ':' || connection_id,
       tenant_id,space_id,project_id,installation_id,connection_id,provider,'',requested_by,'',
       CASE WHEN status='pending' THEN 'not_supported' ELSE status END,attempt_count,last_attempt_at,
       CASE WHEN status='pending' THEN 'legacy_generation_unknown' ELSE action_code END,
       CASE WHEN status='pending' THEN 'legacy_cleanup_generation_unknown' ELSE last_error_code END,
       created_at,updated_at,completed_at
FROM extension_provider_revocation_outcomes;
