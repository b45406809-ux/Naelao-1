-- A quote records the exact, owner-confirmable terms used by an admitted operation.
-- The current caller is the fixed-price managed Workers AI adapter. No prompt or
-- provider credentials are stored with a quote.
CREATE TABLE IF NOT EXISTS managed_service_operation_quotes (
  quote_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  requester_user_id TEXT NOT NULL,
  plan_tier TEXT NOT NULL,
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  operation_name TEXT NOT NULL,
  model_id TEXT,
  region TEXT NOT NULL,
  capability_version INTEGER NOT NULL,
  price_version TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK(credits > 0),
  max_output_tokens INTEGER CHECK(max_output_tokens IS NULL OR max_output_tokens BETWEEN 1 AND 4096),
  status TEXT NOT NULL DEFAULT 'quoted' CHECK(status IN ('quoted','consumed','cancelled')),
  operation_id TEXT UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(provider, service_id, capability_version)
    REFERENCES managed_service_capability_versions(provider, service_id, version),
  FOREIGN KEY(operation_id) REFERENCES managed_service_operations(operation_id)
);
CREATE INDEX IF NOT EXISTS idx_managed_service_operation_quotes_owner
  ON managed_service_operation_quotes(tenant_id, space_id, requester_user_id, status, expires_at);

ALTER TABLE managed_service_operations ADD COLUMN quote_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_service_operations_quote
  ON managed_service_operations(quote_id) WHERE quote_id IS NOT NULL;

ALTER TABLE managed_service_credit_reservations ADD COLUMN quote_id TEXT;
