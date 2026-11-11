-- Track verified immutable erasure-receipt copies in a separately configured R2 bucket.
-- Rows are intentionally retained until product/legal sets a backup-evidence retention rule.
CREATE TABLE IF NOT EXISTS workspace_erasure_backup_exports (
  tombstone_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('global','eu')),
  backup_key TEXT NOT NULL UNIQUE,
  receipt_sha256 TEXT NOT NULL,
  exported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_erasure_backup_exports_scope
  ON workspace_erasure_backup_exports(tenant_id,jurisdiction,exported_at);
