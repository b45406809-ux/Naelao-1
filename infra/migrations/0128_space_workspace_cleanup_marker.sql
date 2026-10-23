-- Keep deleted-space cleanup idempotent across the knowledge and workspace R2 buckets.
ALTER TABLE spaces ADD COLUMN cleanup_completed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_spaces_pending_cleanup
  ON spaces(status, cleanup_completed_at, id);
