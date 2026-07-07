-- Security audit follow-up: neither end users nor builders had any account-recovery path.
-- product_end_users authenticates with a naelao-native email+password (migration 0046) with no
-- way to recover from a lost password other than losing the account. Same hashed-token,
-- single-use, expiring pattern as business_invites (migration 0047) — the token itself is never
-- stored, only its hash, so a leaked D1 row can't be replayed as a live reset link.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id                TEXT PRIMARY KEY,
  product_space_id  TEXT NOT NULL,
  end_user_id       TEXT NOT NULL,
  token_hash        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at        TEXT NOT NULL,
  used_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(product_space_id, end_user_id);
