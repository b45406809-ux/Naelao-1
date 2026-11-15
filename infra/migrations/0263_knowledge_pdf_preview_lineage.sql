-- Preserve the exact PDF source and the reviewed extraction identity separately from derived chunks.
ALTER TABLE kb_documents ADD COLUMN source_sha256 TEXT
  CHECK (source_sha256 IS NULL OR (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^a-f0-9]*'));
ALTER TABLE kb_documents ADD COLUMN source_file_name TEXT
  CHECK (source_file_name IS NULL OR length(source_file_name) BETWEEN 1 AND 255);
ALTER TABLE kb_documents ADD COLUMN parser_version TEXT;
ALTER TABLE kb_documents ADD COLUMN parser_output_sha256 TEXT
  CHECK (parser_output_sha256 IS NULL OR (length(parser_output_sha256) = 64 AND parser_output_sha256 NOT GLOB '*[^a-f0-9]*'));
ALTER TABLE kb_documents ADD COLUMN approved_content_sha256 TEXT
  CHECK (approved_content_sha256 IS NULL OR (length(approved_content_sha256) = 64 AND approved_content_sha256 NOT GLOB '*[^a-f0-9]*'));

CREATE INDEX IF NOT EXISTS idx_kb_documents_pdf_source
  ON kb_documents(tenant_id, space_id, project_id, source_sha256)
  WHERE source_sha256 IS NOT NULL;
