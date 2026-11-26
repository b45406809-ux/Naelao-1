-- MS-35: AgentPort email accounts are provisioned in Naelao Email (service binding NAELAO_EMAIL). Not applied remotely.
--
-- agentport_naelao_email_tenants holds the per-AgentPort-tenant Naelao Email API key. The key is stored ONLY
-- as AES-256-GCM ciphertext sealed with AGENTPORT_JWT_SECRET (HKDF, bound to the tenant id), exactly like
-- agentport_identity_keys.private_key_ciphertext. It is never logged, returned or stored in plaintext.
CREATE TABLE IF NOT EXISTS agentport_naelao_email_tenants (
  tenant_id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL UNIQUE,
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Links an AgentPort mailbox to its Naelao Email inbox and inbox-scoped webhook. The webhook signing secret
-- (returned to the owner as `webhookSecret`) is kept sealed so an idempotent provision replay can return it again.
ALTER TABLE agentport_email_accounts ADD COLUMN nemail_inbox_id TEXT;
ALTER TABLE agentport_email_accounts ADD COLUMN nemail_webhook_id TEXT;
ALTER TABLE agentport_email_accounts ADD COLUMN webhook_secret_ciphertext TEXT;
ALTER TABLE agentport_email_accounts ADD COLUMN webhook_secret_iv TEXT;
