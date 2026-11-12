-- The Cloudflare Workers AI adapter is present locally but remains unavailable until an
-- operator verifies the provider contract, eligible regions and an exact per-model price.
INSERT OR IGNORE INTO managed_service_capability_versions(
  provider,service_id,version,category,operations_json,regions_json,account_modes_json,isolation_model,
  provisioning_json,metering_json,external_effects_json,evidence_json,status,created_at,updated_at
)
VALUES(
  'cloudflare','workers-ai',1,'model-inference','["generate-text"]','[]','["naelao_managed"]',
  'tenant-scoped-request;shared-cloudflare-account',
  '{"caller":"Agents AI binding","admission":"exact-model-plan-region-price"}',
  '{"priceVersion":"operator-required","chargeModel":"fixed-credits-per-operation"}',
  '["workers_ai_inference","cloudflare_account_billing"]',
  '[{"url":"https://developers.cloudflare.com/workers-ai/","note":"Candidate official source; operator must verify current model, geography, terms and account billing before managed use."},{"url":"https://developers.cloudflare.com/workers-ai/platform/pricing/","note":"Candidate price source; current per-model pricing must be reviewed before entitlement activation."}]',
  'draft',datetime('now'),datetime('now')
);

-- Prompts are never persisted. Results are encrypted with tenant-bound keys and deleted after
-- seven days; operation and credit receipts remain for billing/audit reconciliation.
CREATE TABLE IF NOT EXISTS managed_service_model_results(
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  requester_user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(operation_id) REFERENCES managed_service_operations(operation_id)
);
CREATE INDEX IF NOT EXISTS idx_managed_service_model_results_expiry
  ON managed_service_model_results(expires_at);
