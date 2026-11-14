-- Owner retries must resolve the same conformance export after a lost response.
ALTER TABLE blueprint_export_jobs ADD COLUMN request_id TEXT;
ALTER TABLE blueprint_export_jobs ADD COLUMN request_sha256 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_blueprint_export_jobs_request
  ON blueprint_export_jobs(tenant_id, space_id, request_id)
  WHERE request_id IS NOT NULL;
