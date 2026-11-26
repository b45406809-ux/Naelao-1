-- MS-38 (V-spec MR-REC-2/3): inventory and cost reconciliation findings. Not applied remotely.
-- Written only behind MANAGED_RECONCILIATION_ENABLED (default "false"). Findings are observations: nothing here deletes or changes
-- an upstream or local resource. All timestamps are epoch milliseconds. detail_json never holds credentials (the writer scrubs it).
CREATE TABLE IF NOT EXISTS managed_service_reconciliation_findings (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('orphaned_upstream','missing_upstream','state_mismatch','cost_discrepancy')),
  provider TEXT NOT NULL,
  service_id TEXT,
  offering_id TEXT,
  tenant_id TEXT,                 -- NULL for orphans (no local owner) and for provider-wide cost findings
  account_id TEXT,                -- managed_service_accounts.id when a local row exists
  resource_ref TEXT,              -- provider_resource_ref
  period TEXT,                    -- 'YYYY-MM' for cost findings
  detail_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')),
  dedup_key TEXT NOT NULL UNIQUE, -- one finding per condition, however many sweeps observe it
  seen_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  acknowledged_by TEXT,
  acknowledged_at INTEGER,
  acknowledgement_reason TEXT,
  resolved_at INTEGER,
  resolved_by TEXT,               -- 'sweep' when the condition stopped reproducing
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_managed_reconciliation_findings_queue
  ON managed_service_reconciliation_findings(status, kind, provider, last_seen_at);

-- One row per sweep period ('inventory' per UTC day, 'cost' per UTC month): the claim that keeps concurrent cron ticks from repeating a sweep.
CREATE TABLE IF NOT EXISTS managed_service_reconciliation_runs (
  kind TEXT NOT NULL CHECK(kind IN ('inventory','cost')),
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','complete')),
  summary_json TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY(kind, period)
);
