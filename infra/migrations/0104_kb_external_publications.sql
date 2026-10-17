-- Explicitly declassify selected, indexed project documents for restricted external handlers.
-- A collection only points at canonical Knowledge documents; it never copies their contents.
CREATE TABLE IF NOT EXISTS kb_external_publications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_external_publications_scope
  ON kb_external_publications(tenant_id, space_id, project_id);

CREATE TABLE IF NOT EXISTS kb_external_publication_documents (
  publication_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY(publication_id, document_id),
  FOREIGN KEY(publication_id) REFERENCES kb_external_publications(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_kb_external_publication_documents_document
  ON kb_external_publication_documents(tenant_id, space_id, project_id, document_id);

CREATE TRIGGER IF NOT EXISTS kb_external_publication_documents_scope_insert
BEFORE INSERT ON kb_external_publication_documents
WHEN NOT EXISTS (
  SELECT 1 FROM kb_external_publications p
  WHERE p.id=NEW.publication_id AND p.tenant_id=NEW.tenant_id
    AND p.space_id=NEW.space_id AND p.project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'external publication scope mismatch'); END;

CREATE TRIGGER IF NOT EXISTS kb_external_publication_documents_scope_update
BEFORE UPDATE ON kb_external_publication_documents
WHEN NOT EXISTS (
  SELECT 1 FROM kb_external_publications p
  WHERE p.id=NEW.publication_id AND p.tenant_id=NEW.tenant_id
    AND p.space_id=NEW.space_id AND p.project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'external publication scope mismatch'); END;

CREATE TRIGGER IF NOT EXISTS kb_external_publication_document_delete
AFTER DELETE ON kb_documents
BEGIN
  DELETE FROM kb_external_publication_documents
  WHERE document_id=OLD.id AND tenant_id=OLD.tenant_id AND space_id=OLD.space_id
    AND project_id=COALESCE(OLD.project_id, '_space');
END;
