-- Keep document access policy beside canonical Knowledge rows so archive and recovery do not
-- depend on provider Vectorize metadata. NULL means legacy policy must be recovered fail-closed.
ALTER TABLE kb_documents
  ADD COLUMN required_role_rank INTEGER NOT NULL DEFAULT 0
  CHECK (required_role_rank BETWEEN 0 AND 50);
ALTER TABLE kb_documents
  ADD COLUMN allowed_user_ids_json TEXT
  CHECK (allowed_user_ids_json IS NULL OR (json_valid(allowed_user_ids_json) AND json_type(allowed_user_ids_json) = 'array'));
ALTER TABLE kb_documents ADD COLUMN archive_restore_id TEXT;

CREATE INDEX IF NOT EXISTS idx_kb_documents_archive_scope
  ON kb_documents(tenant_id, space_id, project_id, status, id);
