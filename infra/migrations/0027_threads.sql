-- G-T01..T08: Thread system — sequences of sessions for end-users
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  end_user_id TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  summary_updated_at TEXT,
  session_count INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_threads_space_user
  ON threads (space_id, end_user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_tenant
  ON threads (tenant_id, created_at DESC);
