-- MS-45 / MR-EXE-1 step 4: an approval is bound to sha256 of the canonical payload, the resource, the operation, the principal and an
-- expiry, and is decided only by an authenticated human approver who is never the proposer. Read only behind
-- MANAGED_EXECUTION_PIPELINE_ENABLED. Not applied remotely by the task that added it.
CREATE TABLE IF NOT EXISTS managed_execution_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  provider TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  proposer_kind TEXT NOT NULL CHECK (proposer_kind IN ('agent','user','system')),
  proposer_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approver_kind TEXT CHECK (approver_kind IS NULL OR approver_kind='user'),
  approver_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_operation_id TEXT,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_managed_execution_approvals_scope ON managed_execution_approvals(tenant_id,space_id,status,expires_at);
