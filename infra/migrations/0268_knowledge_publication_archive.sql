-- Archive stops Project collection discovery and retrieval while retaining its identity.
-- Content is detached and must be explicitly re-published and re-granted before use.
ALTER TABLE kb_external_publications ADD COLUMN archived_at TEXT;
ALTER TABLE kb_external_publications ADD COLUMN archived_by TEXT;

CREATE TABLE IF NOT EXISTS kb_external_publication_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('archived','restored_as_draft')),
  from_revision INTEGER NOT NULL,
  to_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_external_publication_events_scope
  ON kb_external_publication_events(tenant_id,space_id,project_id,publication_id,to_revision);
