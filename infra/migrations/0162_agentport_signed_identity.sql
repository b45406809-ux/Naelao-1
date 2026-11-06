-- AgentPort canonical Ed25519 identities and revocable, audience-bound agent credentials.
-- Private signing keys are envelope-encrypted by the AgentPort Worker before insertion.
CREATE TABLE IF NOT EXISTS agentport_identity_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  public_jwk_json TEXT NOT NULL,
  private_key_ciphertext TEXT NOT NULL,
  private_key_iv TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotated','revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agentport_agents(id),
  UNIQUE (tenant_id,agent_id,id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_identity_keys_agent ON agentport_identity_keys(tenant_id,agent_id,status);

CREATE TABLE IF NOT EXISTS agentport_issued_credentials (
  jti TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  reason_code TEXT,
  FOREIGN KEY (agent_id) REFERENCES agentport_agents(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_issued_credentials_agent ON agentport_issued_credentials(tenant_id,agent_id,expires_at);
