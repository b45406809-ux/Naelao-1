-- A currently searchable website source must refer to an immutable host-owned connection grant.
CREATE TRIGGER IF NOT EXISTS kb_documents_current_website_source_requires_host_grant
BEFORE INSERT ON kb_documents
WHEN NEW.source_adapter='website' AND NEW.source_state='current'
  AND (NEW.source_connection_ref IS NULL OR length(NEW.source_connection_ref) NOT BETWEEN 1 AND 256
    OR NEW.source_grant_revision IS NULL)
BEGIN SELECT RAISE(ABORT, 'current website source requires host grant reference'); END;

CREATE TRIGGER IF NOT EXISTS kb_documents_current_website_source_update_requires_host_grant
BEFORE UPDATE OF source_adapter,source_connection_ref,source_grant_revision,source_state ON kb_documents
WHEN NEW.source_adapter='website' AND NEW.source_state='current'
  AND (NEW.source_connection_ref IS NULL OR length(NEW.source_connection_ref) NOT BETWEEN 1 AND 256
    OR NEW.source_grant_revision IS NULL)
BEGIN SELECT RAISE(ABORT, 'current website source requires host grant reference'); END;

-- Bound cleanup and revocation for a single host-managed website grant.
CREATE TRIGGER IF NOT EXISTS kb_documents_website_connection_document_limit
BEFORE INSERT ON kb_documents
WHEN NEW.source_adapter='website' AND NEW.source_connection_ref IS NOT NULL
  AND (SELECT COUNT(*) FROM kb_documents WHERE tenant_id=NEW.tenant_id AND space_id=NEW.space_id
    AND source_connection_ref=NEW.source_connection_ref) >= 100
BEGIN SELECT RAISE(ABORT, 'website connection document limit exceeded'); END;
