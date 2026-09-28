-- Batch 13: marketplace pricing, turnkey recipes, and the cumulative anti-plan-hopping ledger.
ALTER TABLE marketplace_listings ADD COLUMN pricing_model TEXT NOT NULL DEFAULT 'freemium_tiered'
  CHECK (pricing_model IN ('freemium_tiered', 'fixed_license'));
ALTER TABLE marketplace_listings ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0);
ALTER TABLE marketplace_listings ADD COLUMN plan_gated_features_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS recipe_installations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL CHECK(recipe_id IN ('shopify_order_to_shipstation','dental_receptionist_desk','ecommerce_returns_assistant')),
  recipe_config_json TEXT NOT NULL,
  installed_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(space_id, project_id, recipe_id)
);

CREATE TABLE IF NOT EXISTS template_subscriptions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  developer_user_id TEXT NOT NULL,
  attribution_channel TEXT NOT NULL CHECK(attribution_channel IN ('DEVELOPER_REFERRAL', 'MARKETPLACE_ORGANIC')),
  cycles_paid_entry_tier INTEGER NOT NULL DEFAULT 0 CHECK(cycles_paid_entry_tier >= 0),
  cycles_paid_growth_tier INTEGER NOT NULL DEFAULT 0 CHECK(cycles_paid_growth_tier >= 0),
  cycles_paid_pro_tier INTEGER NOT NULL DEFAULT 0 CHECK(cycles_paid_pro_tier >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','paused')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_template_subscriptions_space ON template_subscriptions(space_id, status);

CREATE TABLE IF NOT EXISTS developer_earnings_ledger (
  id TEXT PRIMARY KEY,
  template_subscription_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  developer_user_id TEXT NOT NULL,
  attribution_channel TEXT NOT NULL CHECK(attribution_channel IN ('DEVELOPER_REFERRAL', 'MARKETPLACE_ORGANIC')),
  tier TEXT NOT NULL CHECK(tier IN ('entry','growth','pro','fixed_license')),
  cycle_number INTEGER NOT NULL CHECK(cycle_number >= 0),
  gross_cents INTEGER NOT NULL CHECK(gross_cents >= 0),
  developer_cents INTEGER NOT NULL CHECK(developer_cents >= 0),
  platform_cents INTEGER NOT NULL CHECK(platform_cents >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(template_subscription_id) REFERENCES template_subscriptions(id)
);
CREATE INDEX IF NOT EXISTS idx_developer_earnings_user ON developer_earnings_ledger(developer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_developer_earnings_subscription ON developer_earnings_ledger(template_subscription_id, created_at DESC);
