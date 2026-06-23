-- KB documents metadata (content stored in R2, vectors in Vectorize)
CREATE TABLE IF NOT EXISTS kb_documents (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  title        TEXT NOT NULL,
  source_url   TEXT,
  content_type TEXT NOT NULL DEFAULT 'text',  -- text | url | code | pdf
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | processing | indexed | failed
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kb_docs_space   ON kb_documents(space_id);
CREATE INDEX IF NOT EXISTS idx_kb_docs_tenant  ON kb_documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kb_docs_status  ON kb_documents(status);
