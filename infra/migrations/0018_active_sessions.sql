-- G-SS01..SS04: Active session registry for WebSocket dashboard monitoring
CREATE TABLE IF NOT EXISTS active_sessions (
  id TEXT PRIMARY KEY,                       -- session_id
  space_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  end_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',     -- 'active', 'idle', 'ended'
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_as_space ON active_sessions (space_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_as_tenant ON active_sessions (tenant_id, status);
