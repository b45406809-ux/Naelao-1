-- Durable handoff from signed provider payment failures to the dunning workflow.
CREATE TABLE IF NOT EXISTS billing_dunning_outbox (
  workflow_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('lemon_squeezy', 'whop')),
  subscription_id TEXT NOT NULL,
  provider_event_id TEXT,
  provider_updated_at TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'sent')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_dunning_outbox_due
  ON billing_dunning_outbox(status, next_attempt_at, lease_until, created_at);
