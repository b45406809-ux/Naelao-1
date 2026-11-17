-- Preserve the separately authorized scheduled principal and exact job revision on durable
-- billing reservations and usage receipts. These fields are internal audit dimensions and are
-- intentionally not forwarded to external subscription metering.
ALTER TABLE llm_token_reservations ADD COLUMN service_identity_id TEXT;
ALTER TABLE llm_token_reservations ADD COLUMN service_authorization_revision TEXT;
ALTER TABLE usage_events ADD COLUMN service_identity_id TEXT;
ALTER TABLE usage_events ADD COLUMN service_authorization_revision TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_events_service_identity
  ON usage_events(org_id, space_id, service_identity_id, recorded_at);
