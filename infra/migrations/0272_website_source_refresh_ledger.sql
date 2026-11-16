-- Persist page-refresh freshness and retry state without storing fetched content here.
ALTER TABLE kb_documents ADD COLUMN source_last_attempt_at TEXT;
ALTER TABLE kb_documents ADD COLUMN source_last_success_at TEXT;
ALTER TABLE kb_documents ADD COLUMN source_next_attempt_at TEXT;
ALTER TABLE kb_documents ADD COLUMN source_refresh_failures INTEGER NOT NULL DEFAULT 0
  CHECK (source_refresh_failures >= 0);
ALTER TABLE kb_documents ADD COLUMN source_last_error_code TEXT
  CHECK (source_last_error_code IS NULL OR length(source_last_error_code) BETWEEN 1 AND 96);
ALTER TABLE kb_documents ADD COLUMN source_requested_url TEXT;

UPDATE kb_documents SET source_last_success_at=updated_at
  WHERE source_adapter='website' AND source_state='current' AND source_last_success_at IS NULL;
UPDATE kb_documents SET source_requested_url=source_url
  WHERE source_adapter='website' AND source_state='current' AND source_requested_url IS NULL;

CREATE TABLE IF NOT EXISTS kb_source_refresh_operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  connection_ref TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash)=64 AND idempotency_key_hash NOT GLOB '*[^a-f0-9]*'),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('fetching','preview_ready','completed','failed','superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 100),
  requested_url TEXT NOT NULL,
  final_url TEXT,
  preview_sha256 TEXT CHECK (preview_sha256 IS NULL OR (length(preview_sha256)=64 AND preview_sha256 NOT GLOB '*[^a-f0-9]*')),
  last_attempt_at TEXT NOT NULL,
  completed_at TEXT,
  next_attempt_at TEXT,
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 96),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id,space_id,document_id,idempotency_key_hash)
);

CREATE INDEX IF NOT EXISTS idx_kb_source_refresh_latest
  ON kb_source_refresh_operations(tenant_id,space_id,document_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_source_refresh_one_active
  ON kb_source_refresh_operations(tenant_id,space_id,document_id)
  WHERE state IN ('fetching','preview_ready');

CREATE TRIGGER IF NOT EXISTS kb_source_refresh_requires_current_website_source
BEFORE INSERT ON kb_source_refresh_operations
WHEN NOT EXISTS (
  SELECT 1 FROM kb_documents d JOIN website_connections wc
    ON wc.id=d.source_connection_ref AND wc.tenant_id=d.tenant_id AND wc.space_id=d.space_id
      AND wc.project_id=d.project_id AND wc.status='active'
  WHERE d.id=NEW.document_id AND d.tenant_id=NEW.tenant_id AND d.space_id=NEW.space_id
    AND d.project_id=NEW.project_id AND d.source_adapter='website' AND d.source_state='current'
    AND d.source_revision=NEW.source_revision AND d.source_connection_ref=NEW.connection_ref
)
BEGIN SELECT RAISE(ABORT, 'website refresh requires current source and grant'); END;
