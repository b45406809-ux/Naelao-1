-- Launch-readiness audit follow-up: migration 0054 gave END USERS a password-recovery path but
-- builders (platform accounts, workers/auth's own `users` table) still had none — a builder who
-- forgets their password permanently loses access to their own business. Same hashed, single-use,
-- expiring token shape as password_reset_tokens/business_invites; scoped to `users.id` (the
-- platform account), not a product space.
CREATE TABLE IF NOT EXISTS builder_password_reset_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_builder_password_reset_tokens_hash ON builder_password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_builder_password_reset_tokens_user ON builder_password_reset_tokens(user_id);
