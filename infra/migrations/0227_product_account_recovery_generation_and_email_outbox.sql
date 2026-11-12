-- Product account resets have one authoritative D1 boundary. A one-time reset token carries the
-- candidate password hash only until its used_at transition; the trigger updates the account,
-- advances its session generation, journals DO cleanup, and clears that transient hash atomically.
ALTER TABLE product_end_users
  ADD COLUMN security_generation INTEGER NOT NULL DEFAULT 0 CHECK (security_generation >= 0);

ALTER TABLE password_reset_tokens ADD COLUMN pending_password_hash TEXT;

CREATE TABLE product_account_security_outbox (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product_space_id TEXT NOT NULL,
  end_user_id TEXT NOT NULL,
  security_generation INTEGER NOT NULL CHECK (security_generation > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_token TEXT,
  lease_until TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE (product_space_id, end_user_id, security_generation)
);
CREATE INDEX idx_product_account_security_outbox_due
  ON product_account_security_outbox(status, next_attempt_at, lease_until);

-- Any currently suspended product account invalidates preexisting sessions at migration time.
UPDATE product_end_users SET security_generation = 1 WHERE suspended_at IS NOT NULL AND deleted_at IS NULL;
INSERT INTO product_account_security_outbox
  (operation_id, tenant_id, product_space_id, end_user_id, security_generation)
SELECT lower(hex(randomblob(16))), s.tenant_id, u.product_space_id, u.end_user_id, u.security_generation
  FROM product_end_users u JOIN spaces s ON s.id = u.product_space_id
 WHERE u.suspended_at IS NOT NULL AND u.deleted_at IS NULL;

-- Every generation change produces exactly one retryable cleanup operation in the same statement,
-- regardless of whether it came from reset, logout or suspension.
CREATE TRIGGER product_account_security_generation_journal
AFTER UPDATE OF security_generation ON product_end_users
WHEN NEW.security_generation = OLD.security_generation + 1
BEGIN
  INSERT INTO product_account_security_outbox
    (operation_id, tenant_id, product_space_id, end_user_id, security_generation)
  SELECT lower(hex(randomblob(16))), s.tenant_id, u.product_space_id, u.end_user_id, u.security_generation
    FROM product_end_users u JOIN spaces s ON s.id = u.product_space_id
   WHERE u.product_space_id = NEW.product_space_id AND u.end_user_id = NEW.end_user_id;

  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'product_account_security_outbox_missing') END;
END;

-- Consume the one-time verification token and mark its account verified in one D1 statement so a
-- crash cannot burn a valid token without applying the verified state.
CREATE TRIGGER product_email_verification_apply_account_state
AFTER UPDATE OF used_at ON email_verification_tokens
WHEN OLD.used_at IS NULL AND NEW.used_at IS NOT NULL
BEGIN
  UPDATE product_end_users
     SET email_verified_at = COALESCE(email_verified_at, datetime('now'))
   WHERE product_space_id = NEW.product_space_id
     AND end_user_id = NEW.end_user_id
     AND deleted_at IS NULL;

  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'product_email_verification_target_missing') END;
END;

-- Suspension denies requests immediately and invalidates every pre-suspension token even if the
-- account is later reactivated. This also covers future admin suspension routes that update D1.
CREATE TRIGGER product_account_suspend_advance_security_generation
AFTER UPDATE OF suspended_at ON product_end_users
WHEN OLD.suspended_at IS NULL AND NEW.suspended_at IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  UPDATE product_end_users
     SET security_generation = security_generation + 1
   WHERE product_space_id = NEW.product_space_id AND end_user_id = NEW.end_user_id;
END;

CREATE TRIGGER product_password_reset_apply_security_generation
AFTER UPDATE OF used_at ON password_reset_tokens
WHEN OLD.used_at IS NULL AND NEW.used_at IS NOT NULL AND NEW.pending_password_hash IS NOT NULL
BEGIN
  UPDATE product_end_users
     SET password_hash = NEW.pending_password_hash,
         security_generation = security_generation + 1
   WHERE product_space_id = NEW.product_space_id
     AND end_user_id = NEW.end_user_id
     AND deleted_at IS NULL;

  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'product_account_reset_target_missing') END;

  UPDATE password_reset_tokens SET pending_password_hash = NULL WHERE id = NEW.id;
END;

-- Recovery and verification secrets are encrypted with the platform secret before they enter D1.
-- Recipient addresses are encrypted in the same envelope; only a one-way lookup hash is retained
-- for diagnosis and consistency checks.
CREATE TABLE product_auth_email_outbox (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product_space_id TEXT NOT NULL,
  end_user_id TEXT NOT NULL,
  token_id TEXT NOT NULL UNIQUE,
  message_kind TEXT NOT NULL CHECK (message_kind IN ('password_reset', 'email_verification')),
  recipient_hash TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'accepted', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_token TEXT,
  lease_until TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);
CREATE INDEX idx_product_auth_email_outbox_due
  ON product_auth_email_outbox(status, next_attempt_at, lease_until);
CREATE INDEX idx_product_auth_email_outbox_subject
  ON product_auth_email_outbox(tenant_id, product_space_id, end_user_id, message_kind, status);
