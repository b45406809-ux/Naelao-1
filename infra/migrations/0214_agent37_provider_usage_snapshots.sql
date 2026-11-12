-- Owner-triggered Agent37 usage reads are retained as minimized provider API evidence.
-- Provider instance IDs, model names, credentials and raw response bodies are not stored.
CREATE TABLE IF NOT EXISTS sandbox_agent37_usage_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  connection_ref_sha256 TEXT NOT NULL CHECK(length(connection_ref_sha256)=64),
  period_start TEXT NOT NULL CHECK(length(period_start)=10),
  period_end TEXT NOT NULL CHECK(length(period_end)=10),
  total_cost_micros INTEGER NOT NULL CHECK(total_cost_micros>=0),
  usage_json TEXT NOT NULL CHECK(json_valid(usage_json)),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  source_api TEXT NOT NULL CHECK(source_api='agent37.usage'),
  observed_at TEXT NOT NULL,
  UNIQUE(tenant_id,connection_ref_sha256,period_start,period_end,evidence_sha256)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_agent37_usage_owner_period
  ON sandbox_agent37_usage_snapshots(tenant_id,owner_id,period_start,period_end,observed_at);
