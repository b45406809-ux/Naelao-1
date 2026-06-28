-- G-D01: Usage metering table for API calls, KB docs, sessions, messages
CREATE TABLE IF NOT EXISTS usage_events (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  space_id              TEXT,
  event_type            TEXT NOT NULL,  -- 'api_call'|'kb_doc'|'session'|'message'
  quantity              INTEGER NOT NULL DEFAULT 1,
  stripe_meter_event_id TEXT,
  recorded_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_org_month ON usage_events(org_id, recorded_at);

-- G-D02: Add unique constraint on stripe_invoice_id to allow upsert
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_stripe_id ON invoices(stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

-- G-D03: Trial support on subscriptions
ALTER TABLE subscriptions ADD COLUMN trial_ends_at TEXT;
