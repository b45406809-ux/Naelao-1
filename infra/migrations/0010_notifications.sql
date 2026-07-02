-- G-N01..N04: Notification system (in-app + email + webhook dispatch)
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,            -- 'system', 'billing', 'space', 'agent', 'team'
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TEXT,
  action_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_user
  ON notifications (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (tenant_id, user_id, read_at)
  WHERE read_at IS NULL;
