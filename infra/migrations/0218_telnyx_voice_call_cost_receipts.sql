-- One provider-reported call cost per scoped call leg. Store hashes and numeric receipt
-- fields only; provider call identifiers and raw webhook payloads remain transient.
CREATE TABLE IF NOT EXISTS assistant_telnyx_voice_cost_receipts (
  binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id) ON DELETE CASCADE,
  call_leg_id_sha256 TEXT NOT NULL CHECK(length(call_leg_id_sha256)=64),
  call_session_id_sha256 TEXT CHECK(call_session_id_sha256 IS NULL OR length(call_session_id_sha256)=64),
  first_event_id_sha256 TEXT NOT NULL CHECK(length(first_event_id_sha256)=64),
  provider_cost_micros INTEGER NOT NULL CHECK(provider_cost_micros>=0),
  currency TEXT NOT NULL CHECK(length(currency)=3),
  billed_duration_seconds INTEGER CHECK(billed_duration_seconds IS NULL OR billed_duration_seconds>=0),
  occurred_at TEXT NOT NULL,
  cost_evidence_sha256 TEXT NOT NULL CHECK(length(cost_evidence_sha256)=64),
  observed_at TEXT NOT NULL,
  PRIMARY KEY(binding_id,call_leg_id_sha256),
  UNIQUE(binding_id,first_event_id_sha256)
);
CREATE INDEX IF NOT EXISTS assistant_telnyx_voice_cost_receipts_observed
  ON assistant_telnyx_voice_cost_receipts(binding_id,observed_at);
