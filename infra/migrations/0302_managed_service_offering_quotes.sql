-- MS-37 (V-spec MR-COM-4/6/7/8, §9.2, §9.5): generic quotes driven by an offering's charge components.
-- Not applied to any remote database by the repository.
--
-- A quote is bound to tenant (tenant_id), offering, region, configuration hash, price_version and an expiry of at most
-- 15 minutes. It snapshots every charge component and the minimum monthly cost so the owner sees exactly what was quoted.
-- Legacy quotes (agentmail, Workers AI created with MANAGED_OFFERINGS_ENABLED off) leave the new columns NULL.
ALTER TABLE managed_service_operation_quotes ADD COLUMN offering_id TEXT;
ALTER TABLE managed_service_operation_quotes ADD COLUMN configuration_sha256 TEXT
  CHECK(configuration_sha256 IS NULL OR length(configuration_sha256) = 64);
ALTER TABLE managed_service_operation_quotes ADD COLUMN charge_components_json TEXT;
ALTER TABLE managed_service_operation_quotes ADD COLUMN min_monthly_credits INTEGER
  CHECK(min_monthly_credits IS NULL OR min_monthly_credits >= 0);

CREATE INDEX IF NOT EXISTS idx_managed_service_operation_quotes_offering
  ON managed_service_operation_quotes(tenant_id, offering_id, status, expires_at) WHERE offering_id IS NOT NULL;

-- MR-COM-7: an offering-bound quote lives at most 15 minutes.
CREATE TRIGGER IF NOT EXISTS managed_service_offering_quote_expiry_insert
BEFORE INSERT ON managed_service_operation_quotes
WHEN NEW.offering_id IS NOT NULL
  AND (julianday(NEW.expires_at) IS NULL OR julianday(NEW.created_at) IS NULL
    OR (julianday(NEW.expires_at) - julianday(NEW.created_at)) * 86400.0 > 900.5)
BEGIN
  SELECT RAISE(ABORT, 'managed_service_quote_expiry_too_long');
END;
