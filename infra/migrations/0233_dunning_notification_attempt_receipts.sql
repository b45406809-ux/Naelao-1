-- Persist only non-sensitive provider attempt outcomes for durable billing notices.
-- Recipient addresses and message bodies remain in the queue/provider boundary.
CREATE TABLE IF NOT EXISTS dunning_notification_attempts (
  tenant_id TEXT NOT NULL,
  notification_id TEXT NOT NULL CHECK(length(notification_id) = 72 AND substr(notification_id, 1, 8) = 'dunning-'),
  subscription_scope TEXT NOT NULL CHECK(subscription_scope IN ('platform_subscription', 'product_user_subscription')),
  provider TEXT NOT NULL CHECK(provider = 'resend'),
  provider_outcome TEXT NOT NULL CHECK(provider_outcome IN ('provider_accepted', 'provider_rejected', 'attempt_ambiguous')),
  attempt_count INTEGER NOT NULL CHECK(attempt_count > 0),
  last_http_status INTEGER CHECK(last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599),
  provider_receipt_id TEXT CHECK(provider_receipt_id IS NULL OR length(provider_receipt_id) <= 128),
  first_attempt_at TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  accepted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, notification_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_dunning_notification_attempts_tenant_recent
  ON dunning_notification_attempts (tenant_id, last_attempt_at DESC, notification_id);
