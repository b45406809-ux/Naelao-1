-- G-SM01..SM04: Space-level membership (end-users with authenticated access to a Space)
CREATE TABLE IF NOT EXISTS space_members (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  end_user_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member',       -- 'member', 'moderator'
  auth_token_hash TEXT,                      -- current magic-link / OAuth token hash
  auth_token_expires_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  suspended_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sm_unique ON space_members (space_id, end_user_id);
CREATE INDEX IF NOT EXISTS idx_sm_space ON space_members (space_id, suspended_at);
CREATE INDEX IF NOT EXISTS idx_sm_email ON space_members (space_id, email);
