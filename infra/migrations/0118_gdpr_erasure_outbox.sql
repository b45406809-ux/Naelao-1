-- Keep account erasure requests durable if the D1 commit succeeds but Queue delivery fails.
CREATE TABLE IF NOT EXISTS gdpr_erasure_outbox (
  request_id TEXT PRIMARY KEY REFERENCES gdpr_requests(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_gdpr_erasure_outbox_due
  ON gdpr_erasure_outbox (status, next_attempt_at, created_at);
