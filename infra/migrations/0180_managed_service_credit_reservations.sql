-- Managed service holds share the existing infra-credit allowance and usage_events ledger.
-- An uncertain provider effect stays reserved until reconciliation; it never ages out silently.
CREATE TABLE IF NOT EXISTS managed_service_credit_reservations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  region TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  operation_name TEXT NOT NULL,
  payer_type TEXT NOT NULL DEFAULT 'organization' CHECK(payer_type IN ('user','organization','agent')),
  payer_id TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK(credits > 0),
  settled_credits INTEGER CHECK(settled_credits IS NULL OR settled_credits >= 0),
  price_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('held','uncertain','settled','released')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE(org_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_managed_service_credit_reservations_quota
  ON managed_service_credit_reservations(org_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_managed_service_credit_reservations_operation
  ON managed_service_credit_reservations(org_id, provider, service_id, operation_id);
