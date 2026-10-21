-- Keep the daily expired builder reset-token sweep bounded as the token table grows.
CREATE INDEX IF NOT EXISTS idx_builder_password_reset_tokens_expiry
  ON builder_password_reset_tokens(julianday(expires_at));
