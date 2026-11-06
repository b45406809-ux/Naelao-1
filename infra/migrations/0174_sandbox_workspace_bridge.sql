-- Immutable, short lived snapshots and staged blobs for provider neutral sandbox sync.
-- Workspace data remains in the existing SCRIPTS_R2 bucket; these rows authorize access.
ALTER TABLE sandbox_publications ADD COLUMN idempotency_key TEXT;
ALTER TABLE sandbox_publications ADD COLUMN snapshot_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_publications_idempotency
  ON sandbox_publications(tenant_id,filesystem_id,idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS sandbox_workspace_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  filesystem_id TEXT NOT NULL REFERENCES sandbox_filesystems(id),
  computer_id TEXT REFERENCES sandbox_computers(id),
  branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','expired','published')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_workspace_snapshots_expiry
  ON sandbox_workspace_snapshots(status,expires_at);

CREATE TABLE IF NOT EXISTS sandbox_workspace_blobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  filesystem_id TEXT NOT NULL REFERENCES sandbox_filesystems(id),
  snapshot_id TEXT REFERENCES sandbox_workspace_snapshots(id),
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  executable INTEGER NOT NULL DEFAULT 0 CHECK (executable IN (0,1)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_workspace_blobs_expiry
  ON sandbox_workspace_blobs(expires_at);

CREATE TABLE IF NOT EXISTS sandbox_workspace_snapshot_entries (
  snapshot_id TEXT NOT NULL REFERENCES sandbox_workspace_snapshots(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  blob_id TEXT NOT NULL REFERENCES sandbox_workspace_blobs(id),
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  executable INTEGER NOT NULL DEFAULT 0 CHECK (executable IN (0,1)),
  PRIMARY KEY(snapshot_id,path)
);

CREATE TABLE IF NOT EXISTS sandbox_workspace_publication_blobs (
  publication_id TEXT NOT NULL REFERENCES sandbox_publications(id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL REFERENCES sandbox_workspace_blobs(id),
  PRIMARY KEY(publication_id,blob_id)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_workspace_publication_blobs_blob
  ON sandbox_workspace_publication_blobs(blob_id);
