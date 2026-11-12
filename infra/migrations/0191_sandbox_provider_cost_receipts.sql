-- Normalized provider-cost evidence is kept apart from customer credit charges and internal
-- estimates. The import path hashes provider identifiers and stores an operator-provided
-- evidence digest; it does not claim the upstream receipt is cryptographically verified.
CREATE TABLE IF NOT EXISTS sandbox_provider_cost_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('agent37','opensandbox','cloudflare')),
  statement_ref_hash TEXT NOT NULL CHECK(length(statement_ref_hash)=64),
  receipt_ref_hash TEXT NOT NULL CHECK(length(receipt_ref_hash)=64),
  account_ref_hash TEXT NOT NULL CHECK(length(account_ref_hash)=64),
  allocation_ref_hash TEXT CHECK(allocation_ref_hash IS NULL OR length(allocation_ref_hash)=64),
  usage_kind TEXT NOT NULL CHECK(usage_kind IN ('compute','idle','storage','network','other')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  quantity_micros INTEGER NOT NULL CHECK(quantity_micros >= 0),
  provider_cost_micros INTEGER NOT NULL CHECK(provider_cost_micros >= 0),
  currency TEXT NOT NULL CHECK(length(currency)=3),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  provenance TEXT NOT NULL DEFAULT 'operator_imported' CHECK(provenance='operator_imported'),
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE(tenant_id,provider,statement_ref_hash,receipt_ref_hash)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_provider_cost_period
  ON sandbox_provider_cost_receipts(tenant_id,provider,period_start,period_end,currency);
