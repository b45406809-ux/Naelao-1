-- Marketplace purchases already own a durable license transaction. Retain the provider's exact
-- variant and currency alongside its actual charged amount. Historical variants are backfilled
-- only where the listing still has a recorded provider variant; NULL remains unknown otherwise.
ALTER TABLE marketplace_license_purchases ADD COLUMN provider TEXT NOT NULL DEFAULT 'lemon_squeezy';
ALTER TABLE marketplace_license_purchases ADD COLUMN provider_variant_id TEXT;
ALTER TABLE marketplace_license_purchases ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
UPDATE marketplace_license_purchases
SET provider_variant_id = (
  SELECT ls_license_variant_id FROM marketplace_listings WHERE id = marketplace_license_purchases.listing_id
)
WHERE provider_variant_id IS NULL;

-- Capture the same immutable event terms for a second charge held for refund review. Its
-- provider-reported amount already lives on the overpayment row.
ALTER TABLE marketplace_license_overpayments ADD COLUMN provider TEXT NOT NULL DEFAULT 'lemon_squeezy';
ALTER TABLE marketplace_license_overpayments ADD COLUMN provider_variant_id TEXT;
ALTER TABLE marketplace_license_overpayments ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
UPDATE marketplace_license_overpayments
SET provider_variant_id = (
  SELECT ls_license_variant_id FROM marketplace_listings WHERE id = marketplace_license_overpayments.listing_id
)
WHERE provider_variant_id IS NULL;
