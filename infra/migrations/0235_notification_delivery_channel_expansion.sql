-- Synchronous notification callers include first-party chat channels in addition to the
-- queue's normalized email/push/webhook types. Keep their source channel names in the same
-- outcome ledger without storing any message or recipient content.
CREATE TABLE notification_delivery_attempts_v2 (
  tenant_id TEXT NOT NULL,
  notification_id TEXT NOT NULL CHECK(length(notification_id) BETWEEN 1 AND 200),
  channel TEXT NOT NULL CHECK(length(channel) BETWEEN 1 AND 32),
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

INSERT INTO notification_delivery_attempts_v2 (
  tenant_id,notification_id,channel,provider,outcome,attempt_count,queue_attempts,last_http_status,
  provider_receipt_id,failure_code,first_attempt_at,last_attempt_at,accepted_at,updated_at
)
SELECT tenant_id,notification_id,channel,provider,outcome,attempt_count,queue_attempts,last_http_status,
  provider_receipt_id,failure_code,first_attempt_at,last_attempt_at,accepted_at,updated_at
FROM notification_delivery_attempts;

DROP TABLE notification_delivery_attempts;
ALTER TABLE notification_delivery_attempts_v2 RENAME TO notification_delivery_attempts;

CREATE INDEX idx_notification_delivery_tenant_recent
  ON notification_delivery_attempts (tenant_id, last_attempt_at DESC, notification_id);
