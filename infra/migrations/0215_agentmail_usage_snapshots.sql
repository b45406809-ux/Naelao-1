-- Owner-triggered AgentMail usage observations. These are provider-reported quantities,
-- not monetary costs or Naelao credit charges. Raw inbox IDs and API responses are excluded.
CREATE TABLE IF NOT EXISTS managed_service_agentmail_usage_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  owner_user_id TEXT NOT NULL,
  connection_ref_sha256 TEXT NOT NULL CHECK(length(connection_ref_sha256)=64),
  point_at TEXT NOT NULL,
  storage_bytes INTEGER NOT NULL CHECK(storage_bytes>=0),
  message_count INTEGER NOT NULL CHECK(message_count>=0),
  thread_count INTEGER NOT NULL CHECK(thread_count>=0),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  source_api TEXT NOT NULL CHECK(source_api='agentmail.inbox.metrics.usage'),
  observed_at TEXT NOT NULL,
  UNIQUE(tenant_id,connection_ref_sha256,point_at,evidence_sha256)
);
CREATE INDEX IF NOT EXISTS idx_agentmail_usage_owner_point
  ON managed_service_agentmail_usage_snapshots(tenant_id,space_id,owner_user_id,point_at);
