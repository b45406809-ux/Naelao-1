-- Version owner-published collection membership so extension grants authorize one reviewed
-- collection revision. A publication ID alone must not silently authorize later source changes.
ALTER TABLE kb_external_publications
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);
ALTER TABLE kb_external_publications
  ADD COLUMN mutation_token TEXT NOT NULL DEFAULT '';

ALTER TABLE kb_external_publication_documents
  ADD COLUMN publication_revision INTEGER NOT NULL DEFAULT 1 CHECK(publication_revision >= 1);

CREATE INDEX IF NOT EXISTS idx_kb_external_publication_documents_revision
  ON kb_external_publication_documents(tenant_id,space_id,project_id,publication_id,publication_revision,document_id);
