-- Independent AgentPort API credentials. Only a one-way hash of the secret is stored.
CREATE TABLE IF NOT EXISTS agentport_api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('individual','organization','platform')),
  owner_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agentport_api_keys_tenant ON agentport_api_keys(tenant_id, status, owner_id);
