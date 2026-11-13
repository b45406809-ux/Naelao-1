-- Link signed provider call-cost receipts to owner-visible calls without retaining
-- a second raw provider call-control identifier. Existing receipts remain unlinked.
ALTER TABLE assistant_telnyx_voice_cost_receipts
  ADD COLUMN call_control_id_sha256 TEXT
  CHECK(call_control_id_sha256 IS NULL OR length(call_control_id_sha256)=64);

CREATE INDEX assistant_telnyx_voice_cost_receipts_call_control
  ON assistant_telnyx_voice_cost_receipts(binding_id,call_control_id_sha256)
  WHERE call_control_id_sha256 IS NOT NULL;
