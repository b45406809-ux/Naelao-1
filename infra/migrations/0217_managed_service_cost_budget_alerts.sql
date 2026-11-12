-- Durable owner-dashboard events for rolling provider-cost threshold crossings.
-- Alerts are informational, provenance-separated, and never block provider dispatch.
CREATE TABLE IF NOT EXISTS managed_service_cost_budget_alert_state (
  budget_id TEXT PRIMARY KEY,
  threshold_reached INTEGER NOT NULL DEFAULT 0 CHECK(threshold_reached IN (0,1)),
  last_observed_provider_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK(last_observed_provider_cost_micros>=0),
  lease_token TEXT,
  lease_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_service_cost_budget_alerts (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('operator_imported','provider_api_observed')),
  currency TEXT NOT NULL CHECK(length(currency)=3),
  observed_provider_cost_micros INTEGER NOT NULL CHECK(observed_provider_cost_micros>=0),
  limit_provider_cost_micros INTEGER NOT NULL CHECK(limit_provider_cost_micros>0),
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by_user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_managed_service_cost_budget_alert_owner
  ON managed_service_cost_budget_alerts(tenant_id,space_id,project_id,acknowledged_at,created_at DESC);
