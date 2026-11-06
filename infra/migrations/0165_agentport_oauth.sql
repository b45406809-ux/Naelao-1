-- OAuth Authorization Code + PKCE for AgentPort account linking by Naelao and third-party platforms.
-- These records authorize API access only; they do not copy provider/channel account data.
CREATE TABLE IF NOT EXISTS agentport_oauth_clients (
  client_id TEXT PRIMARY KEY,
  owner_tenant_id TEXT NOT NULL,
  owner_developer_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (owner_tenant_id) REFERENCES agentport_organizations(id),
  FOREIGN KEY (owner_developer_id) REFERENCES agentport_developers(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_oauth_clients_owner
  ON agentport_oauth_clients(owner_tenant_id,owner_developer_id,status);

CREATE TABLE IF NOT EXISTS agentport_oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  developer_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES agentport_oauth_clients(client_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES agentport_organizations(id),
  FOREIGN KEY (developer_id) REFERENCES agentport_developers(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_oauth_codes_expiry ON agentport_oauth_codes(expires_at);

CREATE TABLE IF NOT EXISTS agentport_oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  developer_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES agentport_oauth_clients(client_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES agentport_organizations(id),
  FOREIGN KEY (developer_id) REFERENCES agentport_developers(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_oauth_tokens_expiry ON agentport_oauth_tokens(expires_at,revoked_at);

CREATE TABLE IF NOT EXISTS agentport_oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  developer_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by_hash TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES agentport_oauth_clients(client_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES agentport_organizations(id),
  FOREIGN KEY (developer_id) REFERENCES agentport_developers(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_oauth_refresh_expiry ON agentport_oauth_refresh_tokens(expires_at,revoked_at);
