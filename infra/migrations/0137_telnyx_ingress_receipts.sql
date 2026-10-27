-- Replay identity is bound to a carrier event and local binding. Payloads remain in the
-- scoped encrypted body store, not in this delivery journal.
CREATE TABLE IF NOT EXISTS assistant_telnyx_ingress_receipts (
  binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('claimed','completed','indeterminate')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(binding_id,event_id)
);
CREATE INDEX IF NOT EXISTS assistant_telnyx_ingress_state ON assistant_telnyx_ingress_receipts(state,updated_at);
