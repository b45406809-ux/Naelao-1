-- Canonical Knowledge documents retain versioned source lineage and opaque host references.
-- Connector credentials remain in the host connection store and are never placed in Knowledge.
ALTER TABLE kb_documents ADD COLUMN source_adapter TEXT NOT NULL DEFAULT 'manual'
  CHECK (source_adapter IN ('manual','website','connector'));
ALTER TABLE kb_documents ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1
  CHECK (source_revision >= 1);
ALTER TABLE kb_documents ADD COLUMN source_content_sha256 TEXT
  CHECK (source_content_sha256 IS NULL OR (length(source_content_sha256)=64 AND source_content_sha256 NOT GLOB '*[^a-f0-9]*'));
ALTER TABLE kb_documents ADD COLUMN source_connection_ref TEXT;
ALTER TABLE kb_documents ADD COLUMN source_grant_revision INTEGER
  CHECK (source_grant_revision IS NULL OR source_grant_revision >= 1);
ALTER TABLE kb_documents ADD COLUMN source_state TEXT NOT NULL DEFAULT 'current'
  CHECK (source_state IN ('current','stale','revoked','unsupported'));

UPDATE kb_documents SET source_adapter='website'
  WHERE content_type='url';
UPDATE kb_documents SET source_state='unsupported'
  WHERE source_adapter='website' AND content_type='url';

CREATE INDEX IF NOT EXISTS idx_kb_documents_source_lineage
  ON kb_documents(tenant_id,space_id,project_id,source_adapter,source_state,id);

CREATE TRIGGER IF NOT EXISTS kb_documents_connector_source_requires_host_grant
BEFORE INSERT ON kb_documents
WHEN NEW.source_adapter='connector'
  AND (NEW.source_connection_ref IS NULL OR length(NEW.source_connection_ref) NOT BETWEEN 1 AND 256
    OR NEW.source_grant_revision IS NULL)
BEGIN SELECT RAISE(ABORT, 'connector source requires host grant reference'); END;

CREATE TRIGGER IF NOT EXISTS kb_documents_connector_source_update_requires_host_grant
BEFORE UPDATE OF source_adapter,source_connection_ref,source_grant_revision ON kb_documents
WHEN NEW.source_adapter='connector'
  AND (NEW.source_connection_ref IS NULL OR length(NEW.source_connection_ref) NOT BETWEEN 1 AND 256
    OR NEW.source_grant_revision IS NULL)
BEGIN SELECT RAISE(ABORT, 'connector source requires host grant reference'); END;
