-- Preserve the provider resource update revision applied to each current subscription. Webhook
-- delivery IDs prevent duplicate work but do not order distinct lifecycle events. These fields
-- allow same-provider updates to use the signed resource's updated_at value where available.
-- Existing rows remain NULL and can still process events matching their current subscription ID;
-- replacing a current ID requires a strictly newer provider revision.
ALTER TABLE subscriptions ADD COLUMN billing_provider TEXT;
ALTER TABLE subscriptions ADD COLUMN provider_event_at TEXT;
ALTER TABLE business_subscriptions ADD COLUMN provider_event_at TEXT;
