-- Stable Cloudflare Email Routing aliases for each Naelao agent. Only the address digest is
-- retained; raw addresses are deterministically re-derived from the platform HMAC key.
CREATE TABLE IF NOT EXISTS agent_email_addresses (
  address_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, space_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_email_addresses_scope
  ON agent_email_addresses(tenant_id, space_id, agent_id, status);
