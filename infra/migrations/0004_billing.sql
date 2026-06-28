-- Billing: subscriptions and invoices
CREATE TABLE IF NOT EXISTS subscriptions (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL UNIQUE,
  plan_tier             TEXT NOT NULL DEFAULT 'free',
  status                TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  current_period_start  TEXT,
  current_period_end    TEXT,
  cancel_at_period_end  INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'usd',
  status           TEXT NOT NULL DEFAULT 'open',
  stripe_invoice_id TEXT,
  period_start     TEXT,
  period_end       TEXT,
  paid_at          TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON subscriptions(org_id);
CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(org_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(org_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
