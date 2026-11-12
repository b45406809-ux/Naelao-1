ALTER TABLE managed_service_plan_entitlements ADD COLUMN credits_per_operation INTEGER
  CHECK(credits_per_operation IS NULL OR credits_per_operation > 0);

ALTER TABLE managed_service_operation_quotes ADD COLUMN request_sha256 TEXT
  CHECK(request_sha256 IS NULL OR length(request_sha256) = 64);

ALTER TABLE managed_service_operation_quotes ADD COLUMN renewal_credits INTEGER
  CHECK(renewal_credits IS NULL OR renewal_credits > 0);
ALTER TABLE managed_service_operation_quotes ADD COLUMN renewal_price_version TEXT;
ALTER TABLE managed_service_operation_quotes ADD COLUMN renewal_capability_version INTEGER;
ALTER TABLE managed_service_operation_quotes ADD COLUMN renewal_max_credits_per_operation INTEGER
  CHECK(renewal_max_credits_per_operation IS NULL OR renewal_max_credits_per_operation > 0);
