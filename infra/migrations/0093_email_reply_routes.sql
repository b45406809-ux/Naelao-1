-- Opaque, expiring reply addresses bind replies to the agent run that initiated an email.
-- Store only a SHA-256 address digest; the generated local part is returned to the caller once.
CREATE TABLE IF NOT EXISTS email_reply_routes (
  address_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_reply_routes_scope
  ON email_reply_routes(tenant_id, space_id, task_id, status, expires_at);

CREATE TABLE IF NOT EXISTS email_inbound_attachments (
  object_key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_inbound_attachments_expiry
  ON email_inbound_attachments(expires_at);
