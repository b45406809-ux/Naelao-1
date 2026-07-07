-- Security audit follow-up: signup had no email verification, so the pre-auth rate limiter
-- (migration-adjacent router fix) bounds free-credit farming per-IP but doesn't eliminate it —
-- a slow/distributed farmer can still mint accounts. Gate the FREE_TIER_DEFAULT_SIGNUP_CREDITS
-- grant (and any configured creditsIncludedPerMonth) behind a real verified inbox: the account
-- and session are usable immediately at signup (so a legitimate user isn't blocked), but the
-- credit grant itself moves to email verification. Same hashed/single-use/expiring token shape
-- as password_reset_tokens (migration 0054) and business_invites (migration 0047).
ALTER TABLE product_end_users ADD COLUMN email_verified_at TEXT;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id                TEXT PRIMARY KEY,
  product_space_id  TEXT NOT NULL,
  end_user_id       TEXT NOT NULL,
  token_hash        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at        TEXT NOT NULL,
  used_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_hash ON email_verification_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user ON email_verification_tokens(product_space_id, end_user_id);
