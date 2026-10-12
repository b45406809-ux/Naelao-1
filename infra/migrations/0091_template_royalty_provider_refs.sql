ALTER TABLE template_subscriptions ADD COLUMN ls_product_id TEXT;
ALTER TABLE template_subscriptions ADD COLUMN ls_variant_id TEXT;
ALTER TABLE template_subscriptions ADD COLUMN provider_subscription_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_template_subscription_provider_id ON template_subscriptions(provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;
