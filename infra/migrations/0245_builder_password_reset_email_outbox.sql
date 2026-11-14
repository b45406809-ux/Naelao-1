-- Persist builder reset-email work with encrypted token/recipient payloads so the public
-- request path never depends on one synchronous Notifications call succeeding.
CREATE TABLE IF NOT EXISTS builder_password_reset_email_outbox (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL UNIQUE,
  recipient_hash TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  active_notification_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'accepted', 'ambiguous', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_token TEXT,
  lease_until TEXT,
  last_error_code TEXT,
  provider_receipt_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_builder_reset_email_outbox_due
  ON builder_password_reset_email_outbox(status, next_attempt_at, lease_until);
CREATE INDEX IF NOT EXISTS idx_builder_reset_email_outbox_tenant_recent
  ON builder_password_reset_email_outbox(tenant_id, created_at DESC, operation_id);

-- A superseded or consumed token must not remain available to a delayed email retry.
CREATE TRIGGER IF NOT EXISTS builder_reset_email_cancel_on_token_use
AFTER UPDATE OF used_at ON builder_password_reset_tokens
WHEN NEW.used_at IS NOT NULL
BEGIN
  UPDATE builder_password_reset_email_outbox
     SET status = 'cancelled', encrypted_payload = '', active_notification_id = NULL,
         lease_token = NULL, lease_until = NULL, last_error_code = NULL, updated_at = datetime('now')
   WHERE token_id = NEW.id AND status IN ('pending', 'sending');
END;

CREATE TRIGGER IF NOT EXISTS builder_reset_email_cancel_on_token_delete
AFTER DELETE ON builder_password_reset_tokens
BEGIN
  UPDATE builder_password_reset_email_outbox
     SET status = 'cancelled', encrypted_payload = '', active_notification_id = NULL,
         lease_token = NULL, lease_until = NULL, last_error_code = NULL, updated_at = datetime('now')
   WHERE token_id = OLD.id AND status IN ('pending', 'sending');
END;
