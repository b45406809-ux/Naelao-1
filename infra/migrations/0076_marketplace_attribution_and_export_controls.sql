-- 0076: Canonical export metadata and attribution used by the marketplace settlement rails.
ALTER TABLE marketplace_listings ADD COLUMN author_user_id TEXT;
ALTER TABLE marketplace_listings ADD COLUMN monetization_model TEXT NOT NULL DEFAULT 'FREEMIUM_TIERED_SAAS'
  CHECK (monetization_model IN ('FREEMIUM_TIERED_SAAS', 'FIXED_ONE_OFF_UNLOCKED'));
ALTER TABLE marketplace_listings ADD COLUMN minimum_month_one_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketplace_purchases ADD COLUMN attribution_channel TEXT NOT NULL DEFAULT 'MARKETPLACE_ORGANIC'
  CHECK (attribution_channel IN ('DEVELOPER_REFERRAL', 'MARKETPLACE_ORGANIC', 'FIXED_ONE_OFF'));
