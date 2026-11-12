-- Persist the non-secret request needed to resume an operation and schedule bounded,
-- provider-specific read-only reconciliation. This does not make an unknown effect safe to replay.
ALTER TABLE managed_service_operations ADD COLUMN request_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE managed_service_operations ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK(reconcile_attempts >= 0);
ALTER TABLE managed_service_operations ADD COLUMN next_reconcile_at TEXT;
ALTER TABLE managed_service_operations ADD COLUMN last_reconciled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_managed_service_operations_due_reconciliation
  ON managed_service_operations(provider, service_id, status, next_reconcile_at);
