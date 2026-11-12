-- Durable ownership and recovery metadata for specialist Agent37 allocations.
ALTER TABLE sandbox_computers ADD COLUMN connection_id TEXT REFERENCES sandbox_connections(id);
ALTER TABLE sandbox_computers ADD COLUMN active_operation_id TEXT;
ALTER TABLE sandbox_allocations ADD COLUMN image_digest TEXT;
ALTER TABLE sandbox_connections ADD COLUMN execution_key_check_status TEXT NOT NULL DEFAULT 'not_checked'
  CHECK(execution_key_check_status IN ('not_checked','verified','failed'));
ALTER TABLE sandbox_connections ADD COLUMN execution_key_verified_at TEXT;
ALTER TABLE sandbox_connections ADD COLUMN execution_key_check_error_code TEXT;

ALTER TABLE sandbox_operations ADD COLUMN lease_until TEXT;
ALTER TABLE sandbox_operations ADD COLUMN recovery_after TEXT;

ALTER TABLE sandbox_template_versions ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sandbox_template_versions ADD COLUMN verified_by TEXT;
ALTER TABLE sandbox_template_versions ADD COLUMN verified_at TEXT;
ALTER TABLE sandbox_template_versions ADD COLUMN valid_until TEXT;

CREATE TABLE IF NOT EXISTS sandbox_template_audit (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  version TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('verified','disabled','deprecated')),
  actor TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(template_id,version) REFERENCES sandbox_template_versions(template_id,version)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_template_audit_version
  ON sandbox_template_audit(template_id,version,created_at);

ALTER TABLE sandbox_executions ADD COLUMN result_ciphertext TEXT;
ALTER TABLE sandbox_executions ADD COLUMN result_iv TEXT;
ALTER TABLE sandbox_executions ADD COLUMN request_ciphertext TEXT;
ALTER TABLE sandbox_executions ADD COLUMN request_iv TEXT;
ALTER TABLE sandbox_executions ADD COLUMN provider_execution_name TEXT;
ALTER TABLE sandbox_executions ADD COLUMN recovery_after TEXT;
ALTER TABLE sandbox_executions ADD COLUMN allocation_id TEXT REFERENCES sandbox_allocations(id);
ALTER TABLE sandbox_executions ADD COLUMN allocation_generation INTEGER;

CREATE TABLE IF NOT EXISTS sandbox_artifact_transfers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  computer_id TEXT NOT NULL REFERENCES sandbox_computers(id),
  allocation_id TEXT NOT NULL REFERENCES sandbox_allocations(id),
  allocation_generation INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('import','stage_output')),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','complete','staged','published','conflicted','indeterminate','failed')),
  workspace_session_id TEXT,
  workspace_fence INTEGER,
  base_revision INTEGER,
  stage_id TEXT,
  request_json TEXT NOT NULL,
  receipt_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(computer_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_artifact_transfer_status
  ON sandbox_artifact_transfers(tenant_id,status,updated_at);
