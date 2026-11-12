-- Durable provider API observations complement operator-imported statements. They remain
-- explicitly distinct from invoices and customer credit charges.
CREATE TABLE IF NOT EXISTS managed_service_provider_cost_observations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  operation_ref_sha256 TEXT NOT NULL CHECK(length(operation_ref_sha256)=64),
  account_ref_sha256 TEXT NOT NULL CHECK(length(account_ref_sha256)=64),
  usage_kind TEXT NOT NULL CHECK(usage_kind IN ('compute','idle','storage','network','request','model','voice','sms','email','other')),
  quantity_unit TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  quantity_micros INTEGER NOT NULL CHECK(quantity_micros>=0),
  provider_cost_micros INTEGER NOT NULL CHECK(provider_cost_micros>=0),
  currency TEXT NOT NULL CHECK(length(currency)=3),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  source_api TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(tenant_id,provider,service_id,evidence_sha256)
);
CREATE INDEX IF NOT EXISTS idx_managed_service_cost_observation_period
  ON managed_service_provider_cost_observations(tenant_id,space_id,provider,service_id,period_start,period_end,currency);
CREATE INDEX IF NOT EXISTS idx_managed_service_cost_observation_operation
  ON managed_service_provider_cost_observations(tenant_id,operation_ref_sha256);
