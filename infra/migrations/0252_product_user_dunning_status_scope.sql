-- Product users may inspect only their own current subscription and non-PII notice outcome.
-- These nullable references preserve compatibility with old platform receipts and older queued
-- messages. New Product-user receipts are inserted only when the exact active account and
-- provider subscription still exist; account erasure deletes the scoped rows.
ALTER TABLE dunning_notification_attempts ADD COLUMN product_id TEXT;
ALTER TABLE dunning_notification_attempts ADD COLUMN end_user_id TEXT;
ALTER TABLE dunning_notification_attempts ADD COLUMN subscription_provider TEXT;
ALTER TABLE dunning_notification_attempts ADD COLUMN provider_subscription_id TEXT;

CREATE INDEX idx_dunning_notification_attempts_product_user_recent
  ON dunning_notification_attempts (tenant_id, product_id, end_user_id, subscription_provider, provider_subscription_id, last_attempt_at DESC, notification_id);
