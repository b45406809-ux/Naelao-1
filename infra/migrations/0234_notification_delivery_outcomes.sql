-- Store provider/queue outcomes without retaining recipients, content, device tokens, or endpoints.
CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  tenant_id TEXT NOT NULL,
  notification_id TEXT NOT NULL CHECK(length(notification_id) BETWEEN 1 AND 200),
  channel TEXT NOT NULL CHECK(channel IN ('email', 'in_app', 'webhook', 'push', 'web_push')),
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 64),
  outcome TEXT NOT NULL CHECK(outcome IN ('provider_accepted', 'provider_rejected', 'attempt_ambiguous', 'not_sent', 'dead_lettered', 'persisted')),
  attempt_count INTEGER NOT NULL CHECK(attempt_count > 0),
  queue_attempts INTEGER NOT NULL CHECK(queue_attempts > 0),
  last_http_status INTEGER CHECK(last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599),
  provider_receipt_id TEXT CHECK(provider_receipt_id IS NULL OR length(provider_receipt_id) <= 128),
  failure_code TEXT CHECK(failure_code IS NULL OR length(failure_code) <= 80),
  first_attempt_at TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  accepted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, notification_id, channel, provider)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_notification_delivery_tenant_recent
  ON notification_delivery_attempts (tenant_id, last_attempt_at DESC, notification_id);
