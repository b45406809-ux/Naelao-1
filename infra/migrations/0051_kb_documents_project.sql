-- WS-4: per-project knowledge base (spec A1.16.20). kb_documents was space-scoped only — a
-- customer-service bot project could not carry its own document KB isolated from the rest of
-- the space. NULL = space-wide (the pre-existing default, unchanged for every existing row).
ALTER TABLE kb_documents ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_kb_docs_project ON kb_documents(project_id) WHERE project_id IS NOT NULL;
