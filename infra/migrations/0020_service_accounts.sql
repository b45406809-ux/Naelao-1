-- G-SA01..SA04: Service accounts — machine-to-machine auth for internal services
CREATE TABLE IF NOT EXISTS service_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  key_hash TEXT NOT NULL,                    -- PBKDF2 hash of the service key
  key_prefix TEXT NOT NULL,                  -- first 8 chars for display
  scopes_json TEXT NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sa_tenant ON service_accounts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sa_prefix ON service_accounts (key_prefix);
