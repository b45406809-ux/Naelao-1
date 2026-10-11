-- Passwordless WhatsApp identity for product end users.
-- Secrets are hashed; challenges are short-lived, single-use, and attempt-limited.
ALTER TABLE product_end_users ADD COLUMN phone_e164 TEXT;
ALTER TABLE product_end_users ADD COLUMN phone_verified_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_end_users_phone
  ON product_end_users(product_space_id, phone_e164)
  WHERE phone_e164 IS NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_auth_challenges (
  id               TEXT PRIMARY KEY,
  product_space_id TEXT NOT NULL,
  end_user_id      TEXT NOT NULL,
  phone_e164       TEXT NOT NULL,
  otp_hash         TEXT NOT NULL,
  magic_hash       TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  expires_at       TEXT NOT NULL,
  used_at          TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_auth_lookup
  ON whatsapp_auth_challenges(product_space_id, phone_e164, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_auth_magic
  ON whatsapp_auth_challenges(product_space_id, magic_hash);
