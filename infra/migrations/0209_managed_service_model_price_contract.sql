ALTER TABLE managed_service_model_entitlements ADD COLUMN credits_per_operation INTEGER
  CHECK(credits_per_operation IS NULL OR credits_per_operation > 0);
ALTER TABLE managed_service_model_entitlements ADD COLUMN max_output_tokens INTEGER
  CHECK(max_output_tokens IS NULL OR max_output_tokens BETWEEN 1 AND 4096);
