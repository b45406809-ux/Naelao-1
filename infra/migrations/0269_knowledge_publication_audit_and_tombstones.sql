-- Expand lifecycle receipts to cover publication mutations/deletion. Keep the receipt ledger
-- content-free and reserve deleted publication IDs so stale revision-pinned grants cannot revive.
ALTER TABLE kb_external_publication_events RENAME TO kb_external_publication_events_v1;
DROP INDEX IF EXISTS idx_kb_external_publication_events_scope;

CREATE TABLE kb_external_publication_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('published','updated','archived','restored_as_draft','deleted')),
  from_revision INTEGER NOT NULL,
  to_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO kb_external_publication_events
  (event_id,tenant_id,space_id,project_id,publication_id,actor_id,action,from_revision,to_revision,created_at)
SELECT event_id,tenant_id,space_id,project_id,publication_id,actor_id,action,from_revision,to_revision,created_at
FROM kb_external_publication_events_v1;
DROP TABLE kb_external_publication_events_v1;
CREATE INDEX idx_kb_external_publication_events_scope
  ON kb_external_publication_events(tenant_id,space_id,project_id,publication_id,to_revision);

CREATE TABLE IF NOT EXISTS kb_external_publication_tombstones (
  publication_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  deleted_revision INTEGER NOT NULL CHECK(deleted_revision >= 1),
  deleted_by TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_external_publication_tombstones_scope
  ON kb_external_publication_tombstones(tenant_id,space_id,project_id,deleted_at);
