-- Append-only observations of provider-reported costs. BYO charges remain with the carrier;
-- these rows are evidence, not an instruction to charge a customer.
CREATE TABLE IF NOT EXISTS assistant_telnyx_usage_receipts (
  receipt_hash TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL REFERENCES assistant_phone_actions(id) ON DELETE CASCADE,
  provider_message_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  provider_completed_at TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS assistant_telnyx_usage_action ON assistant_telnyx_usage_receipts(binding_id,action_id,observed_at);
