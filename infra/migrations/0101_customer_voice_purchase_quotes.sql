-- Short-lived, single-use confirmations for owner-approved Twilio local number purchases.
CREATE TABLE IF NOT EXISTS customer_voice_purchase_quotes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  provider_account_sid TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  country_code TEXT NOT NULL,
  monthly_cost_minor INTEGER NOT NULL CHECK (monthly_cost_minor >= 0),
  inbound_price_per_minute_minor INTEGER NOT NULL CHECK (inbound_price_per_minute_minor >= 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  quoted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted', 'processing', 'completed', 'failed')),
  number_binding_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_customer_voice_purchase_quotes_expiry
  ON customer_voice_purchase_quotes(status, expires_at);
