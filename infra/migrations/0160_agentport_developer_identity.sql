-- AgentPort's developer login and organization directory are independent of Naelao builder accounts.
CREATE TABLE IF NOT EXISTS agentport_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_developer_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agentport_developers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES agentport_organizations(id),
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  token_version INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agentport_developers_org ON agentport_developers(tenant_id,status,role);

CREATE TABLE IF NOT EXISTS agentport_auth_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agentport_auth_rate_limits_window ON agentport_auth_rate_limits(window_started_ms);
