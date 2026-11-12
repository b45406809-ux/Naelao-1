-- Owner-configured informational thresholds over explicitly sourced provider cost evidence.
-- These alerts do not block provider actions and do not imply invoice reconciliation.
CREATE TABLE IF NOT EXISTS managed_service_cost_budgets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('operator_imported','provider_api_observed')),
  currency TEXT NOT NULL CHECK(length(currency)=3),
  limit_provider_cost_micros INTEGER NOT NULL CHECK(limit_provider_cost_micros>0),
  created_by_user_id TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_service_cost_budget_scope
  ON managed_service_cost_budgets(tenant_id,space_id,COALESCE(project_id,''),provider,service_id,provenance,currency);
CREATE INDEX IF NOT EXISTS idx_managed_service_cost_budget_owner
  ON managed_service_cost_budgets(tenant_id,space_id,project_id,updated_at);
