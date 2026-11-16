-- A caller retry after a lost create response must resolve to the same document and must not
-- charge parsing, storage or indexing twice. Store only a hash of the client request key.
CREATE TABLE IF NOT EXISTS kb_document_idempotency_requests (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_scope TEXT NOT NULL,
  key_sha256 TEXT NOT NULL CHECK (length(key_sha256) = 64 AND key_sha256 NOT GLOB '*[^a-f0-9]*'),
  request_sha256 TEXT CHECK (request_sha256 IS NULL OR (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^a-f0-9]*')),
  document_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','deleted')),
  dispatch_state TEXT NOT NULL DEFAULT 'claimed' CHECK (dispatch_state IN ('claimed','dispatching')),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (tenant_id, space_id, project_scope, key_sha256),
  CHECK ((state = 'active' AND request_sha256 IS NOT NULL AND deleted_at IS NULL)
      OR (state = 'deleted' AND request_sha256 IS NULL AND deleted_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_kb_document_idempotency_document
  ON kb_document_idempotency_requests(document_id, tenant_id, space_id);
