-- Migration 0075: Marketplace Subscriptions & Multi-Party Settlement Ledger

CREATE TABLE IF NOT EXISTS template_subscriptions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL UNIQUE,
  template_id TEXT NOT NULL,
  developer_user_id TEXT NOT NULL,
  attribution_channel TEXT NOT NULL CHECK (attribution_channel IN ('DEVELOPER_REFERRAL', 'MARKETPLACE_ORGANIC', 'FIXED_ONE_OFF')),
  
  -- Cumulative Tier Usage Counters (Anti-Plan-Hopping)
  cycles_paid_entry_tier INTEGER NOT NULL DEFAULT 0,  -- Capped at 6 max for plans <= $25
  cycles_paid_growth_tier INTEGER NOT NULL DEFAULT 0, -- Capped at 12 max for plans $26 - $100
  cycles_paid_pro_tier INTEGER NOT NULL DEFAULT 0,    -- Unlimited for plans >= $150
  
  last_billed_plan_price_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ts_space ON template_subscriptions(space_id);
CREATE INDEX IF NOT EXISTS idx_ts_dev ON template_subscriptions(developer_user_id);

CREATE TABLE IF NOT EXISTS developer_earnings_ledger (
  id TEXT PRIMARY KEY,
  developer_user_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('subscription_cut', 'one_off_license_sale', 'plugin_sale')),
  gross_cents INTEGER NOT NULL,
  developer_cut_cents INTEGER NOT NULL,
  platform_cut_cents INTEGER NOT NULL,
  period TEXT NOT NULL, -- e.g. "2026-09"
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_del_dev ON developer_earnings_ledger(developer_user_id, period);
