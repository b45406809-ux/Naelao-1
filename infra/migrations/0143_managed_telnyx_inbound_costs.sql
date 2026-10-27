-- Managed inbound SMS also consumes carrier funds. Reserve plan credits at authenticated ingress,
-- then reconcile the provider's finalized message receipt asynchronously.
CREATE TABLE IF NOT EXISTS assistant_managed_telnyx_message_costs (
  provider_message_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction='inbound'),
  sender TEXT NOT NULL,
  carrier_reservation_id TEXT NOT NULL UNIQUE,
  reserved_credits INTEGER NOT NULL CHECK(reserved_credits>0),
  status TEXT NOT NULL CHECK(status IN ('pending','running','observed','held','expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  lease_until INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_managed_telnyx_cost_due
  ON assistant_managed_telnyx_message_costs(status,next_at,lease_until);
