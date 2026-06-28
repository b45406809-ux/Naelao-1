-- G-T01..T08: D1 session registry for thread membership tracking
-- Sessions are primarily in SpaceDO SQLite; this table is the D1 shadow
-- used for cross-session thread queries without hitting each DO individually.
CREATE TABLE IF NOT EXISTS thread_sessions (
  id TEXT PRIMARY KEY,             -- session_id (same as SpaceDO)
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  end_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  summary TEXT,                    -- per-session LLM summary for thread context
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ts_thread ON thread_sessions (thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_ts_tenant ON thread_sessions (tenant_id, space_id);
