-- Whop added as a second PLATFORM billing provider alongside Lemon Squeezy (Whop is tried first
-- where a builder's own Whop seller account exists; LS stays a fallback — see AUDIT_TODO.md
-- AI-7). Same "no cheap DROP COLUMN, add a new provider-specific pair" precedent 0062 already set
-- for the Stripe->LS cutover: ls_customer_id/ls_subscription_id stay untouched.
ALTER TABLE subscriptions ADD COLUMN whop_customer_id TEXT;
ALTER TABLE subscriptions ADD COLUMN whop_subscription_id TEXT;
