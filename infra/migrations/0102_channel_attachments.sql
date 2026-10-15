-- Opaque, task-scoped handles for inbound channel attachments. Storage keys remain private.
CREATE TABLE IF NOT EXISTS channel_attachments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  object_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channel_attachments_scope
  ON channel_attachments(tenant_id, space_id, task_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_channel_attachments_expiry
  ON channel_attachments(expires_at);
