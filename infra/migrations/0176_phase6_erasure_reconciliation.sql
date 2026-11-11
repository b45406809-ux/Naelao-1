-- Workspace erasure authority survives coordinator restore and legacy prefix cleanup.
-- Keep the row after completion so an older backup cannot make an erased scope writable.
CREATE TABLE IF NOT EXISTS workspace_erasure_tombstones (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tombstone_id TEXT NOT NULL UNIQUE,
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('global','eu')),
  status TEXT NOT NULL CHECK (status IN ('pending','cleaning','complete')),
  cleanup_phase TEXT NOT NULL DEFAULT 'legacy' CHECK (cleanup_phase IN ('legacy','bridge','complete')),
  cleanup_cursor TEXT,
  bridge_cleanup_cursor TEXT,
  cleanup_page INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (tenant_id,space_id,project_id)
);

-- Provider deletion is a separate durable effect. These rows deliberately have no FK to the
-- project/computer tables so erasure can remove application data without losing provider IDs,
-- connection references, unknown outcomes, or the deletion receipt.
CREATE TABLE IF NOT EXISTS sandbox_provider_deletion_operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT,
  project_id TEXT,
  computer_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  connection_id TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('agent37','opensandbox','cloudflare','local','webcontainer')),
  external_id TEXT,
  generation INTEGER NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','dispatching','deletion_requested','indeterminate','confirmed_deleted','retained')),
  reason_code TEXT,
  last_observed_state TEXT,
  delete_dispatched_at TEXT,
  last_reconciled_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_provider_deletion_pending
  ON sandbox_provider_deletion_operations(status,updated_at);
CREATE INDEX IF NOT EXISTS idx_sandbox_provider_deletion_scope
  ON sandbox_provider_deletion_operations(tenant_id,space_id,project_id,status);

-- A pending journal's write path is durable metadata too. A later flag change must never
-- reinterpret a legacy per-file journal as a coordinator publication or vice versa.
ALTER TABLE sandbox_publications ADD COLUMN publication_mode TEXT NOT NULL DEFAULT 'legacy'
  CHECK (publication_mode IN ('legacy','coordinator'));

-- Coarse durable latest observation for each allocation generation. The unique key keeps the
-- reconciliation ledger bounded while retaining the latest known state and reason.
CREATE TABLE IF NOT EXISTS sandbox_allocation_reconciliation_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  computer_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  observed_state TEXT NOT NULL CHECK (observed_state IN ('running','sleeping','deleted','error','unknown')),
  reason_code TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE (tenant_id,allocation_id,generation)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_allocation_reconciliation_time
  ON sandbox_allocation_reconciliation_receipts(observed_at);

-- Provider invoice comparisons are immutable receipts. A variance is surfaced for manual
-- reconciliation; it is never auto-charged or settled by this table.
CREATE TABLE IF NOT EXISTS sandbox_billing_reconciliations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  statement_ref_hash TEXT NOT NULL,
  measured_micros INTEGER NOT NULL CHECK (measured_micros >= 0),
  provider_micros INTEGER NOT NULL CHECK (provider_micros >= 0),
  variance_micros INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  status TEXT NOT NULL CHECK (status IN ('matched','variance')),
  observed_at TEXT NOT NULL,
  UNIQUE (tenant_id,provider,period_start,period_end,statement_ref_hash)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_billing_reconciliation_status
  ON sandbox_billing_reconciliations(status,observed_at);
