-- Actual provider costs are reported separately from customer credit reservations and charges.
-- This table records reviewed operator imports; it does not claim a provider-signed receipt.
CREATE TABLE IF NOT EXISTS managed_service_provider_cost_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  operation_ref_hash TEXT,
  statement_ref_hash TEXT NOT NULL CHECK(length(statement_ref_hash)=64),
  receipt_ref_hash TEXT NOT NULL CHECK(length(receipt_ref_hash)=64),
  account_ref_hash TEXT NOT NULL CHECK(length(account_ref_hash)=64),
  allocation_ref_hash TEXT CHECK(allocation_ref_hash IS NULL OR length(allocation_ref_hash)=64),
  usage_kind TEXT NOT NULL CHECK(usage_kind IN ('compute','idle','storage','network','request','model','voice','sms','email','other')),
  quantity_unit TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  quantity_micros INTEGER NOT NULL CHECK(quantity_micros>=0),
  provider_cost_micros INTEGER NOT NULL CHECK(provider_cost_micros>=0),
  currency TEXT NOT NULL CHECK(length(currency)=3),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  provenance TEXT NOT NULL DEFAULT 'operator_imported' CHECK(provenance='operator_imported'),
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE(tenant_id,provider,service_id,statement_ref_hash,receipt_ref_hash)
);
CREATE INDEX IF NOT EXISTS idx_managed_service_cost_receipt_period
  ON managed_service_provider_cost_receipts(tenant_id,space_id,provider,service_id,period_start,period_end,currency);
CREATE INDEX IF NOT EXISTS idx_managed_service_cost_receipt_operation
  ON managed_service_provider_cost_receipts(tenant_id,operation_ref_hash);
