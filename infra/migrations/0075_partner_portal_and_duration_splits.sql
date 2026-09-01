-- 0075: Developer Partner Accounts, Template Monetization & Tier-Based Duration Settlement
-- Supports 3 Monetization Scenarios:
-- 1. DEVELOPER_REFERRAL (40% recurring)
-- 2. MARKETPLACE_ORGANIC (20% recurring)
-- 3. FIXED_ONE_OFF (100% upfront / 0% ongoing)
-- Plus Duration Caps:
-- - Entry Tier (< $50/mo): 6 Months only
-- - Growth Tier ($50 - < $150/mo): 12 Months
-- - Pro Tier ($150+/mo): Lifetime Recurring

-- Developer Partner Accounts
CREATE TABLE IF NOT EXISTS partner_accounts (
  id TEXT PRIMARY KEY,               -- e.g. "dev_john_102"
  user_id TEXT NOT NULL UNIQUE,      -- Links to platform user
  display_name TEXT NOT NULL,
  payout_email TEXT NOT NULL,
  payout_destination_json TEXT,      -- Bank/Stripe/Crypto/Whop details
  commission_rate_pct REAL NOT NULL DEFAULT 50.0,
  total_earned_cents INTEGER NOT NULL DEFAULT 0,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Partner Templates Metadata & Distribution
CREATE TABLE IF NOT EXISTS partner_templates (
  id TEXT PRIMARY KEY,               -- e.g. "tpl_dental_receptionist_v1"
  partner_id TEXT NOT NULL REFERENCES partner_accounts(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,            -- 'legal', 'healthcare', 'real_estate', 'agency', 'finance'
  description TEXT NOT NULL,
  blueprint_r2_key TEXT NOT NULL,    -- Points to compiled `blueprint.json` in R2
  price_cents_monthly INTEGER NOT NULL DEFAULT 9900, -- $99/mo (for freemium pricing reference or base)
  price_cents_one_off INTEGER NOT NULL DEFAULT 0,    -- e.g. $99 one-off
  fixed_price_cents INTEGER NOT NULL DEFAULT 0,
  monetization_type TEXT NOT NULL DEFAULT 'subscription' CHECK (monetization_type IN ('subscription', 'fixed_one_off')),
  monetization_model TEXT NOT NULL DEFAULT 'FREEMIUM_TIERED_SAAS' CHECK (monetization_model IN ('FREEMIUM_TIERED_SAAS', 'FIXED_ONE_OFF_UNLOCKED')),
  tier_access_rules_json TEXT,       -- JSON specifying allowedProjectKinds, allowedPlugins, maxExecutionTier per tier
  is_public INTEGER NOT NULL DEFAULT 0, -- 1 = in public marketplace; 0 = private invite link only
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Attributed Client Template Subscriptions & Cycle Constraints with Per-Tier Cumulative Quotas
CREATE TABLE IF NOT EXISTS template_subscriptions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL UNIQUE,     -- The deployed client space
  template_id TEXT NOT NULL,
  developer_user_id TEXT NOT NULL,
  
  -- Attribution: 'DEVELOPER_REFERRAL' (40%), 'MARKETPLACE_ORGANIC' (20%), 'FIXED_ONE_OFF' (100% upfront / 0% sub)
  attribution_channel TEXT NOT NULL CHECK (attribution_channel IN ('DEVELOPER_REFERRAL', 'MARKETPLACE_ORGANIC', 'FIXED_ONE_OFF')),
  
  monthly_sub_cents INTEGER NOT NULL,     -- 2000 ($20), 5000 ($50), 15000 ($150)
  developer_split_pct REAL NOT NULL,      -- 40.0, 20.0, or 0.0
  
  -- Cumulative Tier Usage Counters (Prevents plan-hopping gaming)
  cycles_paid_entry_tier INTEGER NOT NULL DEFAULT 0,  -- Capped at 6 max for plans <= $25
  cycles_paid_growth_tier INTEGER NOT NULL DEFAULT 0, -- Capped at 12 max for plans $26 - $149
  cycles_paid_pro_tier INTEGER NOT NULL DEFAULT 0,    -- Unlimited for plans >= $150
  
  -- Total cycle count & legacy max_commission_cycles
  billing_cycle_count INTEGER NOT NULL DEFAULT 0,
  max_commission_cycles INTEGER,
  last_billed_plan_price_cents INTEGER NOT NULL DEFAULT 0,
  
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Payout Ledger for Developer Earnings
CREATE TABLE IF NOT EXISTS developer_earnings_ledger (
  id TEXT PRIMARY KEY,
  developer_user_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  event_type TEXT NOT NULL,               -- 'monthly_subscription_cut' | 'one_off_license_sale'
  gross_cents INTEGER NOT NULL,
  developer_cut_cents INTEGER NOT NULL,
  platform_cut_cents INTEGER NOT NULL,
  period TEXT NOT NULL,                   -- 'YYYY-MM'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dev_earnings_user ON developer_earnings_ledger(developer_user_id);
CREATE INDEX IF NOT EXISTS idx_dev_earnings_space ON developer_earnings_ledger(space_id);
CREATE INDEX IF NOT EXISTS idx_tpl_subs_dev ON template_subscriptions(developer_user_id);
CREATE INDEX IF NOT EXISTS idx_partner_acc_user ON partner_accounts(user_id);
