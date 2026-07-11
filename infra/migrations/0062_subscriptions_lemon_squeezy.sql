-- Platform-plan billing cutover: Lemon Squeezy is the ONLY billing provider (Stripe removed).
-- The builder's own platform subscription (growth/business plan) now settles through the same
-- Lemon Squeezy store as every other money path. The stripe_* columns from 0004 stay in place
-- (D1 has no cheap DROP COLUMN and rows may carry historical values) but nothing writes them
-- any more.
ALTER TABLE subscriptions ADD COLUMN ls_customer_id TEXT;
ALTER TABLE subscriptions ADD COLUMN ls_subscription_id TEXT;
