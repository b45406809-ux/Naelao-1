-- Provider-neutral account and operation references. Provider credentials stay in their
-- existing vault/adapter storage; this registry contains references and billing ownership only.
CREATE TABLE IF NOT EXISTS managed_service_capability_versions (
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  category TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  regions_json TEXT NOT NULL DEFAULT '[]',
  account_modes_json TEXT NOT NULL,
  isolation_model TEXT NOT NULL,
  provisioning_json TEXT NOT NULL DEFAULT '{}',
  metering_json TEXT NOT NULL DEFAULT '{}',
  external_effects_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','verified','disabled')),
  verified_by TEXT,
  verified_at TEXT,
  valid_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider, service_id, version)
);

CREATE TABLE IF NOT EXISTS managed_service_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  capability_version INTEGER,
  connection_mode TEXT NOT NULL CHECK(connection_mode IN ('naelao_managed','user_connected','provider_managed')),
  provider_resource_ref TEXT NOT NULL,
  provider_account_ref TEXT,
  agentport_principal_id TEXT,
  agentport_agent_id TEXT,
  agentport_account_id TEXT,
  credential_ref TEXT,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('user','organization','agent')),
  owner_id TEXT NOT NULL,
  provider_payer_type TEXT NOT NULL CHECK(provider_payer_type IN ('user','organization','agent','platform','provider')),
  provider_payer_id TEXT,
  agentport_fee_payer_type TEXT CHECK(agentport_fee_payer_type IN ('user','organization','agent','platform','provider')),
  agentport_fee_payer_id TEXT,
  credit_payer_type TEXT CHECK(credit_payer_type IN ('user','organization','agent')),
  credit_payer_id TEXT,
  region TEXT,
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('provisioning','active','billing_hold','suspended','retirement_review_required','revoking','revoked','retired','failed','unknown')),
  entitlement_snapshot_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(provider, service_id, capability_version)
    REFERENCES managed_service_capability_versions(provider, service_id, version)
);
CREATE INDEX IF NOT EXISTS idx_managed_service_accounts_owner
  ON managed_service_accounts(tenant_id, owner_type, owner_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_managed_service_accounts_project
  ON managed_service_accounts(tenant_id, space_id, project_id, provider, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_managed_service_accounts_agentport
  ON managed_service_accounts(tenant_id, agentport_agent_id, agentport_account_id);

CREATE TABLE IF NOT EXISTS managed_service_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  account_id TEXT,
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  capability_version INTEGER,
  operation_name TEXT NOT NULL,
  region TEXT,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
  status TEXT NOT NULL CHECK(status IN ('pending','running','complete','held','uncertain','failed','cancelled')),
  lease_until TEXT,
  reservation_id TEXT,
  price_version TEXT,
  reserved_credits INTEGER CHECK(reserved_credits IS NULL OR reserved_credits >= 0),
  provider_operation_ref TEXT,
  result_ref TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, provider, idempotency_key),
  FOREIGN KEY(account_id) REFERENCES managed_service_accounts(id),
  FOREIGN KEY(provider, service_id, capability_version)
    REFERENCES managed_service_capability_versions(provider, service_id, version)
);
CREATE INDEX IF NOT EXISTS idx_managed_service_operations_reconcile
  ON managed_service_operations(tenant_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_managed_service_operations_account
  ON managed_service_operations(tenant_id, account_id, created_at);

-- Import existing AgentMail resources as provider-neutral references. API credentials remain
-- encrypted in assistant_agentmail_accounts and are never copied into this registry.
INSERT OR IGNORE INTO managed_service_accounts (
  id, tenant_id, space_id, project_id, provider, service_id, connection_mode,
  provider_resource_ref, provider_account_ref, agentport_agent_id, agentport_account_id,
  owner_type, owner_id, provider_payer_type, provider_payer_id,
  credit_payer_type, credit_payer_id, lifecycle_state, metadata_json, created_at, updated_at
)
SELECT id, tenant_id, space_id, project_id, 'agentmail', 'agentmail', mode,
       inbox_id, pod_id, agentport_agent_id, agentport_account_id,
       CASE WHEN mode='naelao_managed' THEN 'organization' ELSE 'user' END,
       CASE WHEN mode='naelao_managed' THEN tenant_id ELSE owner_user_id END,
       CASE WHEN mode='naelao_managed' THEN 'platform' ELSE 'user' END,
       CASE WHEN mode='naelao_managed' THEN 'naelao' ELSE owner_user_id END,
       CASE WHEN mode='naelao_managed' THEN 'organization' ELSE NULL END,
       CASE WHEN mode='naelao_managed' THEN tenant_id ELSE NULL END,
       CASE status
         WHEN 'active' THEN 'active'
         WHEN 'provisioning' THEN 'provisioning'
         WHEN 'billing_hold' THEN 'billing_hold'
         WHEN 'suspended' THEN 'suspended'
         WHEN 'retirement_review_required' THEN 'retirement_review_required'
         WHEN 'retired' THEN 'retired'
         WHEN 'failed' THEN 'failed'
         ELSE 'unknown'
       END,
       json_object('email_address', email_address, 'mode', mode), created_at, updated_at
FROM assistant_agentmail_accounts;

-- This captures the current adapter surface as a draft. A source audit does not authorize
-- managed use: an operator must verify service account, region, price and commercial eligibility.
INSERT OR IGNORE INTO managed_service_capability_versions (
  provider,service_id,version,category,operations_json,regions_json,account_modes_json,
  isolation_model,provisioning_json,metering_json,external_effects_json,evidence_json,
  status,created_at,updated_at
)
VALUES (
  'agentmail','agentmail',1,'email',
  '["provision","renew","read","send","search","threads","attachments"]',
  '[]','["naelao_managed","user_connected"]','provider_inbox_per_mailbox',
  '{"createIdempotency":"client_id","unknownCreateRecovery":"read_only_list_by_client_id","requiresWebhook":true}',
  '{"priceVersion":"operator_required","providerUsageReceipt":"operator_required"}',
  '["create_inbox","create_webhook","send_message"]',
  '[{"url":"https://docs.agentmail.to/webhooks-overview","checkedAt":"2026-11-11","note":"Webhook contract; recheck on verification."},{"url":"https://docs.agentmail.to/messages","checkedAt":"2026-11-11","note":"Message API contract; recheck on verification."},{"url":"https://docs.agentmail.to/attachments","checkedAt":"2026-11-11","note":"Attachment API contract; recheck on verification."}]',
  'draft',datetime('now'),datetime('now')
);
