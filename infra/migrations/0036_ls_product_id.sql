-- Auto-create-variant-on-publish: store the LS product id alongside the variant id.
-- ls_variant_id was already present (0035); add ls_product_id for reverse lookup.
ALTER TABLE launchpad_products ADD COLUMN ls_product_id TEXT;
