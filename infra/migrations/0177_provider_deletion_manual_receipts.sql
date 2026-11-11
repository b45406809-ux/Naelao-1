-- An operator may record out-of-band provider evidence when automatic inspection cannot
-- resolve deletion. Keep only keyed digests of the evidence reference and operator identity.
CREATE TABLE IF NOT EXISTS sandbox_provider_deletion_manual_receipts (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  evidence_ref_hash TEXT NOT NULL CHECK (length(evidence_ref_hash)=64),
  operator_id_hash TEXT NOT NULL CHECK (length(operator_id_hash)=64),
  observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_provider_manual_receipt_tenant
  ON sandbox_provider_deletion_manual_receipts(tenant_id,recorded_at);
