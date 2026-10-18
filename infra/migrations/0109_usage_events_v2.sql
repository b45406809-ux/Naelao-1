ALTER TABLE usage_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE usage_events ADD COLUMN unit TEXT NOT NULL DEFAULT 'units';
ALTER TABLE usage_events ADD COLUMN rate_card_version TEXT;
ALTER TABLE usage_events ADD COLUMN cost_credits INTEGER CHECK (cost_credits IS NULL OR cost_credits >= 0);
ALTER TABLE usage_events ADD COLUMN project_id TEXT;
ALTER TABLE usage_events ADD COLUMN installation_id TEXT;
ALTER TABLE usage_events ADD COLUMN run_id TEXT;
ALTER TABLE usage_events ADD COLUMN provider TEXT;
ALTER TABLE usage_events ADD COLUMN model_id TEXT;
ALTER TABLE usage_events ADD COLUMN connector_provider TEXT;
ALTER TABLE usage_events ADD COLUMN runtime_tier INTEGER;
ALTER TABLE usage_events ADD COLUMN subject_hash TEXT;
ALTER TABLE usage_events ADD COLUMN payer_kind TEXT CHECK (payer_kind IS NULL OR payer_kind IN ('space_wallet','consumer_credits','plan_quota','platform','unknown'));
ALTER TABLE usage_events ADD COLUMN decision TEXT CHECK (decision IS NULL OR decision IN ('allowed','denied','charged','released','failed','not_billable'));

CREATE INDEX IF NOT EXISTS idx_usage_events_project_time
  ON usage_events(org_id, space_id, project_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_installation_time
  ON usage_events(org_id, installation_id, recorded_at);
