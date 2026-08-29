-- 0073: Marketplace Template Authoring, Selling, Royalties & Purchases
-- Allows builders, agencies, and niche experts to export, publish, license, and sell templates.

ALTER TABLE marketplace_listings ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketplace_listings ADD COLUMN pricing_model TEXT NOT NULL DEFAULT 'one_time'; -- 'free', 'one_time', 'recurring_monthly', 'gmv_royalty'
ALTER TABLE marketplace_listings ADD COLUMN royalty_share_bps INTEGER NOT NULL DEFAULT 0; -- e.g. 200 = 2%, 500 = 5%
ALTER TABLE marketplace_listings ADD COLUMN blueprint_r2_key TEXT;
ALTER TABLE marketplace_listings ADD COLUMN blueprint_json TEXT;
ALTER TABLE marketplace_listings ADD COLUMN security_review_status TEXT NOT NULL DEFAULT 'audit_passed'; -- 'pending', 'audit_passed', 'flagged'
ALTER TABLE marketplace_listings ADD COLUMN safety_score INTEGER NOT NULL DEFAULT 100;
ALTER TABLE marketplace_listings ADD COLUMN active_licensees_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketplace_listings ADD COLUMN monthly_recurring_revenue_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketplace_listings ADD COLUMN version TEXT NOT NULL DEFAULT '1.0.0';

CREATE TABLE IF NOT EXISTS marketplace_purchases (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  buyer_tenant_id TEXT NOT NULL,
  buyer_user_id TEXT NOT NULL,
  creator_tenant_id TEXT NOT NULL,
  pricing_model TEXT NOT NULL,
  gross_cents INTEGER NOT NULL,
  platform_cut_cents INTEGER NOT NULL,
  creator_payout_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (listing_id) REFERENCES marketplace_listings (id)
);

CREATE INDEX IF NOT EXISTS idx_mp_buyer ON marketplace_purchases(buyer_tenant_id, buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_mp_creator ON marketplace_purchases(creator_tenant_id);
