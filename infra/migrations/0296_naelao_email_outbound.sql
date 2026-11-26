-- MS-33: Naelao Email outbound send, drafts, abuse limits and usage. Not applied remotely.
-- nemail_tenants.daily_send_limit_override (0294) is the operator-only per-tenant daily limit override (NULL = default).
ALTER TABLE nemail_tenants ADD COLUMN sending_paused_reason TEXT;
ALTER TABLE nemail_tenants ADD COLUMN sending_paused_at TEXT;
-- Set when an operator clears a pause; auto-pause statistics only count deliveries created after it.
ALTER TABLE nemail_tenants ADD COLUMN sending_resumed_at TEXT;

ALTER TABLE nemail_drafts ADD COLUMN cc_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE nemail_drafts ADD COLUMN bcc_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE nemail_drafts ADD COLUMN sent_message_id TEXT;

ALTER TABLE nemail_deliveries ADD COLUMN error_code TEXT;
-- One delivery row per message and recipient (envelope send); DSN/ARF reports update it by (message_id, recipient).
CREATE UNIQUE INDEX IF NOT EXISTS idx_nemail_deliveries_message_recipient ON nemail_deliveries(message_id, recipient) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nemail_deliveries_status ON nemail_deliveries(nemail_tenant_id, status, created_at);

-- Local usage ledger (meter email.message.sent, one row per message). UNIQUE makes recording idempotent.
-- Billing integration to Naelao Managed arrives with MS-35.
CREATE TABLE IF NOT EXISTS nemail_usage (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  meter TEXT NOT NULL DEFAULT 'email.message.sent',
  quantity INTEGER NOT NULL DEFAULT 1,
  message_id TEXT NOT NULL REFERENCES nemail_messages(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('sent','unknown')),
  period TEXT NOT NULL,                 -- UTC YYYY-MM
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (nemail_tenant_id, meter, message_id)
);
CREATE INDEX IF NOT EXISTS idx_nemail_usage_period ON nemail_usage(nemail_tenant_id, period);
