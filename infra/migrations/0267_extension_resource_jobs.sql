-- Durable host-managed job admission for exact Project-bound extension installations.
-- Queue messages contain only job IDs; signed workflow identity, owner grant revision,
-- payload reference, deadline and state remain in this ledger.
CREATE TABLE IF NOT EXISTS extension_resource_jobs (
  job_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  release_version TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64),
  requirement_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),
  resource_sha256 TEXT NOT NULL CHECK(length(resource_sha256)=64),
  installation_generation INTEGER NOT NULL CHECK(installation_generation >= 1),
  grant_revision INTEGER NOT NULL CHECK(grant_revision >= 1),
  actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  caller_workflow_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL CHECK(length(idempotency_key_sha256)=64),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  workflow_id TEXT NOT NULL,
  child_start_key TEXT NOT NULL,
  payload_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 2 AND payload_bytes <= 65536),
  deadline_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','dispatching','running','succeeded','failed','unknown','dead_lettered','cancelled','expired')),
  dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_attempts >= 0),
  dispatch_lease_until INTEGER,
  workflow_run_id TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE(tenant_id,space_id,project_id,installation_id,requirement_id,actor_id,idempotency_key_sha256)
);
CREATE INDEX IF NOT EXISTS idx_extension_resource_jobs_dispatch
  ON extension_resource_jobs(status,updated_at,deadline_at);
CREATE INDEX IF NOT EXISTS idx_extension_resource_jobs_installation
  ON extension_resource_jobs(tenant_id,space_id,project_id,installation_id,requirement_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_extension_resource_jobs_actor
  ON extension_resource_jobs(tenant_id,space_id,project_id,installation_id,actor_id,created_at);
