-- 0074: Add ACL metadata to kb_documents for Mini-AGI Permissioned RAG
ALTER TABLE kb_documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE kb_documents ADD COLUMN allowed_roles TEXT;
ALTER TABLE kb_documents ADD COLUMN allowed_user_ids TEXT;
CREATE INDEX IF NOT EXISTS idx_kb_docs_visibility ON kb_documents(visibility);
