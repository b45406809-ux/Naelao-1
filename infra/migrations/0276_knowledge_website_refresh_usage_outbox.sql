-- A stable, unpriced usage receipt for each claimed scheduled website refresh.
-- Pending receipts remain retryable if the Billing Worker is temporarily unavailable.
CREATE TABLE IF NOT EXISTS kb_website_refresh_usage_outbox (
  run_id TEXT PRIMARY KEY CHECK (length(run_id)=58 AND run_id GLOB 'scheduled_[0-9a-f]*'
    AND run_id NOT GLOB 'scheduled_*[^0-9a-f]*'),
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key='knowledge-website-refresh:'||run_id
    AND length(idempotency_key) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at TEXT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code IN ('billing_usage_unavailable','billing_usage_rejected')),
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status='sent' AND sent_at IS NOT NULL) OR status='pending')
);

CREATE INDEX IF NOT EXISTS idx_kb_website_refresh_usage_outbox_pending
  ON kb_website_refresh_usage_outbox(status,created_at,run_id);
