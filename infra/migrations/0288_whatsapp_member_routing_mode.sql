-- The default preserves the existing staff-and-customer behavior for already-connected channels.
ALTER TABLE channel_links ADD COLUMN member_routing_mode TEXT NOT NULL DEFAULT 'staff_and_customers'
  CHECK (member_routing_mode IN ('customer_service_only', 'staff_and_customers'));
ALTER TABLE channel_links ADD COLUMN member_routing_revision INTEGER NOT NULL DEFAULT 1
  CHECK (member_routing_revision > 0);

CREATE TABLE IF NOT EXISTS assistant_channel_member_routing_mode_audit (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'whatsapp'),
  mode TEXT NOT NULL CHECK (mode IN ('customer_service_only', 'staff_and_customers')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  actor_user_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assistant_channel_member_routing_mode_audit_scope
  ON assistant_channel_member_routing_mode_audit (tenant_id, space_id, occurred_at);

-- Provider event identities and sender identities are keyed before storage. The state row both
-- supports owner-visible last use and prevents a retried event from being redirected after a
-- member changes their selected assistant.
CREATE TABLE IF NOT EXISTS assistant_channel_member_route_use_audit (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'whatsapp'),
  project_id TEXT NOT NULL DEFAULT '',
  contact_id TEXT NOT NULL,
  provider_route_key TEXT NOT NULL,
  sender_key TEXT NOT NULL,
  provider_event_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('dispatching', 'dispatched', 'unknown', 'rejected')),
  occurred_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_channel_member_route_use_event
  ON assistant_channel_member_route_use_audit (channel, provider_route_key, sender_key, provider_event_key);

CREATE INDEX IF NOT EXISTS idx_assistant_channel_member_route_use_scope
  ON assistant_channel_member_route_use_audit (tenant_id, space_id, user_id, channel, project_id, status, occurred_at);
