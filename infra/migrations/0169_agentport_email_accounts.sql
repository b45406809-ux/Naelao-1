-- AgentPort's first native provisioner: provider-backed email identities.
-- Message bodies are delivered to the customer's verified webhook and are never stored here.
CREATE TABLE IF NOT EXISTS agentport_email_accounts (
  account_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  inbound_webhook_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (account_id) REFERENCES agentport_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agentport_agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agentport_email_address ON agentport_email_accounts(address,status);

-- Idempotency and delivery receipts contain no recipient, subject, body, or attachment data.
CREATE TABLE IF NOT EXISTS agentport_email_sends (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('sending','sent','indeterminate')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, account_id, idempotency_key),
  FOREIGN KEY (account_id) REFERENCES agentport_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agentport_agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agentport_email_sends_daily ON agentport_email_sends(account_id,created_at);
