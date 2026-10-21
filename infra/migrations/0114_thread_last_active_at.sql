-- G-T01..T08: Add the activity timestamp used by thread listing and updates.
ALTER TABLE threads ADD COLUMN last_active_at TEXT;

UPDATE threads
SET last_active_at = COALESCE(last_message_at, updated_at, created_at, datetime('now'))
WHERE last_active_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_threads_tenant_activity
  ON threads (tenant_id, last_active_at DESC);
