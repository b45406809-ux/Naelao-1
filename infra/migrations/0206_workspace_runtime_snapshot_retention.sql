-- Keep a non-restorable, opaque inventory of provider snapshots through their documented
-- retention window. Cloudflare exposes no supported snapshot purge API, so expiry is recorded
-- as unverified rather than asserted as physical deletion.
CREATE TABLE IF NOT EXISTS workspace_runtime_snapshot_retention (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  runtime_object_sha256 TEXT NOT NULL CHECK(length(runtime_object_sha256)=64),
  snapshot_handle_sha256 TEXT NOT NULL CHECK(length(snapshot_handle_sha256)=64),
  image_sha256 TEXT NOT NULL CHECK(length(image_sha256)=64),
  allocation_generation INTEGER NOT NULL CHECK(allocation_generation >= 0),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('retained','reference_dropped','erasure_notified','ttl_elapsed_unverified')),
  erasure_notified_at TEXT,
  provider_purge_supported INTEGER NOT NULL DEFAULT 0 CHECK(provider_purge_supported=0),
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id,space_id,project_id,runtime_object_sha256,snapshot_handle_sha256)
);

CREATE INDEX IF NOT EXISTS idx_workspace_runtime_snapshot_retention_due
  ON workspace_runtime_snapshot_retention(state,expires_at);
CREATE INDEX IF NOT EXISTS idx_workspace_runtime_snapshot_retention_scope
  ON workspace_runtime_snapshot_retention(tenant_id,space_id,project_id,created_at);
