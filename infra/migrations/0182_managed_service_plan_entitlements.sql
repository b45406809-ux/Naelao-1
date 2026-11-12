-- Product/plan eligibility is a separate verified gate from provider capability and org quota.
-- No rows are activated here; plan, region, price and provider eligibility remain operator decisions.
CREATE TABLE IF NOT EXISTS managed_service_plan_entitlements (
  plan_tier TEXT NOT NULL CHECK(plan_tier IN ('free','growth','business','enterprise')),
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  capability_version INTEGER NOT NULL,
  operation_name TEXT NOT NULL,
  region TEXT NOT NULL,
  price_version TEXT NOT NULL,
  max_credits_per_operation INTEGER NOT NULL CHECK(max_credits_per_operation > 0),
  max_operations_per_period INTEGER CHECK(max_operations_per_period IS NULL OR max_operations_per_period > 0),
  status TEXT NOT NULL CHECK(status IN ('draft','active','disabled')),
  verified_by TEXT,
  verified_at TEXT,
  valid_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(plan_tier,provider,service_id,operation_name,region),
  FOREIGN KEY(provider,service_id,capability_version)
    REFERENCES managed_service_capability_versions(provider,service_id,version)
);
CREATE INDEX IF NOT EXISTS idx_managed_service_entitlements_admission
  ON managed_service_plan_entitlements(plan_tier,provider,service_id,operation_name,region,status);

CREATE TABLE IF NOT EXISTS managed_service_entitlement_audit (
  id TEXT PRIMARY KEY,
  plan_tier TEXT NOT NULL,
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  operation_name TEXT NOT NULL,
  region TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('verified','disabled')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(plan_tier,provider,service_id,operation_name,region)
    REFERENCES managed_service_plan_entitlements(plan_tier,provider,service_id,operation_name,region)
);
CREATE INDEX IF NOT EXISTS idx_managed_service_entitlement_audit_scope
  ON managed_service_entitlement_audit(plan_tier,provider,service_id,operation_name,region,created_at);
