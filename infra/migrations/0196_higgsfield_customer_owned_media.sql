-- Customer-owned Higgsfield API credentials and request receipts. The capability remains a
-- draft until operator and product/legal review approves the exact account, region and terms.
INSERT OR IGNORE INTO managed_service_capability_versions(
  provider,service_id,version,category,operations_json,regions_json,account_modes_json,isolation_model,
  provisioning_json,metering_json,external_effects_json,evidence_json,status,created_at,updated_at)
VALUES(
  'higgsfield','kling-video-v4-text-to-video',1,'media',
  '["estimate","generate","status","cancel","delete"]','[]','["user_connected"]',
  'customer-owned Higgsfield API key; requests are owner-scoped and media is retained only by the provider unless explicitly downloaded',
  '{}','{"providerPayer":"customer","currency":"USD","priceSource":"authenticated_estimate"}',
  '["sends prompt to Higgsfield","provider charges the customer API balance","output media may be processed by third-party partner models","provider request metadata is retained under provider terms","customer application must enforce end-user terms, age and consent requirements"]',
  '[{"url":"https://open.higgsfield.ai/models/kling-video/v4.0/text-to-video/api-reference","checkedAt":"2026-11-11T00:00:00.000Z","note":"Model-specific production endpoint, request fields, async status and output shape. Verification is still required before activation."},{"url":"https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md","checkedAt":"2026-11-11T00:00:00.000Z","note":"Authenticated estimates, successful-generation charging, cancellation refunds, seven-day media retention and immediate request deletion."},{"url":"https://open.higgsfield.ai/terms-of-service","checkedAt":"2026-11-11T00:00:00.000Z","note":"Current API terms require end-user flow-down agreements, age and likeness consent controls, and written consent for standalone resale/service-bureau use."}]',
  'draft',datetime('now'),datetime('now'));

CREATE TABLE IF NOT EXISTS assistant_higgsfield_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  assistant_identity_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  credential_ciphertext TEXT NOT NULL,
  credential_iv TEXT NOT NULL,
  credential_fingerprint TEXT NOT NULL CHECK(length(credential_fingerprint)=64),
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(id) REFERENCES managed_service_accounts(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_higgsfield_accounts_owner_scope
  ON assistant_higgsfield_accounts(tenant_id,space_id,COALESCE(project_id,''),owner_user_id);
CREATE INDEX IF NOT EXISTS idx_higgsfield_accounts_scope
  ON assistant_higgsfield_accounts(tenant_id,space_id,project_id,status,updated_at);

CREATE TABLE IF NOT EXISTS assistant_higgsfield_estimates (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  owner_user_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  amount_usd TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES assistant_higgsfield_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_higgsfield_estimates_owner
  ON assistant_higgsfield_estimates(account_id,owner_user_id,expires_at);

CREATE TABLE IF NOT EXISTS assistant_higgsfield_requests (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  owner_user_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  idempotency_hash TEXT NOT NULL CHECK(length(idempotency_hash)=64),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  estimate_id TEXT NOT NULL,
  estimated_usd TEXT NOT NULL,
  credential_fingerprint TEXT NOT NULL CHECK(length(credential_fingerprint)=64),
  provider_request_id TEXT,
  provider_status_url TEXT,
  provider_cancel_url TEXT,
  provider_status TEXT NOT NULL CHECK(provider_status IN ('submitting','unknown','queued','in_progress','completed','failed','nsfw','canceled','deleted')),
  provider_expires_at TEXT,
  result_ciphertext TEXT,
  result_iv TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id,idempotency_hash),
  UNIQUE(account_id,provider_request_id),
  FOREIGN KEY(operation_id) REFERENCES managed_service_operations(operation_id),
  FOREIGN KEY(account_id) REFERENCES assistant_higgsfield_accounts(id),
  FOREIGN KEY(estimate_id) REFERENCES assistant_higgsfield_estimates(id)
);
CREATE INDEX IF NOT EXISTS idx_higgsfield_requests_owner
  ON assistant_higgsfield_requests(tenant_id,space_id,project_id,owner_user_id,created_at);
