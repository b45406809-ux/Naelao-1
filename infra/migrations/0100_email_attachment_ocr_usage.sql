-- Count OCR attempts without storing image content or model output. The worker enforces a
-- rolling per-Space limit before each hosted inference and expires rows after 30 days.
CREATE TABLE IF NOT EXISTS email_attachment_ocr_usage (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_attachment_ocr_usage_space_time
  ON email_attachment_ocr_usage(tenant_id, space_id, created_at);
