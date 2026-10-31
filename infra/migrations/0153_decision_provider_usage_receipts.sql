-- Durable OpenRouter generation receipt used to recover a verifier call whose local
-- settlement acknowledgement was lost. The receipt never stores prompts or answers.
ALTER TABLE decision_call_reservations ADD COLUMN provider_generation_id TEXT;
ALTER TABLE decision_call_reservations ADD COLUMN provider_cost_usd REAL CHECK(provider_cost_usd IS NULL OR provider_cost_usd >= 0);
ALTER TABLE decision_call_reservations ADD COLUMN usage_evidence_source TEXT CHECK(usage_evidence_source IS NULL OR usage_evidence_source IN ('openrouter_response','openrouter_generation_api'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_reservation_provider_generation
  ON decision_call_reservations(org_id, provider_generation_id)
  WHERE provider_generation_id IS NOT NULL;
