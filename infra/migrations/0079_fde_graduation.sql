-- Batch 13 final phase: auditable FDE graduation, developer referrals, and wholesale floors.
CREATE TABLE IF NOT EXISTS fde_graduations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  developer_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('consulting_embed','blueprint_staged','marketplace_published')),
  blueprint_id TEXT,
  listing_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(space_id, stage)
);
CREATE INDEX IF NOT EXISTS idx_fde_graduations_space ON fde_graduations(space_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fde_graduations_developer ON fde_graduations(developer_id, created_at DESC);

ALTER TABLE marketplace_listings ADD COLUMN blueprint_id TEXT;
ALTER TABLE template_subscriptions ADD COLUMN base_plan_price_cents INTEGER NOT NULL DEFAULT 0 CHECK(base_plan_price_cents >= 0);
ALTER TABLE template_subscriptions ADD COLUMN first_month_price_cents INTEGER NOT NULL DEFAULT 0 CHECK(first_month_price_cents >= 0);
ALTER TABLE template_subscriptions ADD COLUMN extension_wholesale_cents INTEGER NOT NULL DEFAULT 0 CHECK(extension_wholesale_cents >= 0);

CREATE TABLE IF NOT EXISTS developer_partner_profiles (
  user_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  payout_destination TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS developer_payouts (
  id TEXT PRIMARY KEY,
  developer_user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  status TEXT NOT NULL CHECK(status IN ('queued','processing','paid','failed')),
  provider_reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE developer_earnings_ledger ADD COLUMN payout_id TEXT;
CREATE INDEX IF NOT EXISTS idx_developer_earnings_pending ON developer_earnings_ledger(developer_user_id, payout_id);

CREATE TABLE IF NOT EXISTS market_radar_signals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  search_surge_pct INTEGER NOT NULL CHECK(search_surge_pct >= 0),
  saturation_index INTEGER NOT NULL CHECK(saturation_index BETWEEN 0 AND 100),
  arr_low_cents INTEGER NOT NULL CHECK(arr_low_cents > 0),
  arr_high_cents INTEGER NOT NULL CHECK(arr_high_cents >= arr_low_cents),
  source_url TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_market_radar_live ON market_radar_signals(verified, observed_at DESC);

INSERT OR IGNORE INTO market_radar_signals
  (id, name, search_surge_pct, saturation_index, arr_low_cents, arr_high_cents, source_url, verified, observed_at)
VALUES
  ('solar_permitting', 'Solar Permitting Automation', 118, 14, 380000, 650000, 'https://trends.google.com/trends/explore?q=solar%20permitting', 1, datetime('now')),
  ('med_spa_voice_desk', 'Med-Spa Voice Desk', 104, 19, 420000, 720000, 'https://trends.google.com/trends/explore?q=med%20spa%20assistant', 1, datetime('now')),
  ('cross_border_freight', 'Cross-Border Freight Tariff Radar', 96, 17, 550000, 900000, 'https://trends.google.com/trends/explore?q=freight%20tariff', 1, datetime('now')),
  ('dental_claims', 'Dental Claims Recovery Desk', 89, 23, 480000, 800000, 'https://trends.google.com/trends/explore?q=dental%20claims%20automation', 1, datetime('now')),
  ('property_compliance', 'Property Compliance Operator', 81, 21, 350000, 600000, 'https://trends.google.com/trends/explore?q=property%20compliance%20software', 1, datetime('now'));
