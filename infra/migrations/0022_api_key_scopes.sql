-- G-AK01..AK06: API keys with fine-grained scopes
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,                    -- PBKDF2 hash of the full key
  key_prefix TEXT NOT NULL,                  -- first 12 chars shown in UI
  scopes_json TEXT NOT NULL DEFAULT '[]',    -- e.g. ["spaces:read","sessions:write"]
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ak_tenant ON api_keys (tenant_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_ak_prefix ON api_keys (key_prefix);
