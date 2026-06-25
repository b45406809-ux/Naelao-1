-- G-OA01..OA06: OAuth provider configurations for Space end-user authentication
CREATE TABLE IF NOT EXISTS oauth_providers (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,                    -- 'google', 'github', 'microsoft', 'custom'
  client_id TEXT NOT NULL,
  client_secret_ref TEXT NOT NULL,           -- references credentials table
  scopes_json TEXT NOT NULL DEFAULT '["openid","email","profile"]',
  redirect_uri TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  state TEXT NOT NULL UNIQUE,
  code_verifier TEXT,
  redirect_after TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_op_space ON oauth_providers (space_id, enabled);
CREATE UNIQUE INDEX IF NOT EXISTS idx_op_unique ON oauth_providers (space_id, provider);
CREATE INDEX IF NOT EXISTS idx_os_state ON oauth_sessions (state, expires_at);
