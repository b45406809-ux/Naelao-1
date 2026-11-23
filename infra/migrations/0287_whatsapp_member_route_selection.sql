-- Expiring explicit route selection for a verified sender with access to more than one assistant.
-- sender_key is already keyed to the provider destination and platform secret; no phone is stored.
CREATE TABLE IF NOT EXISTS assistant_channel_member_route_selections (
  channel TEXT NOT NULL CHECK (channel = 'whatsapp'),
  provider_route_key TEXT NOT NULL,
  sender_key TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  selected_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_command_event_id TEXT NOT NULL,
  PRIMARY KEY (channel, provider_route_key, sender_key)
);

CREATE INDEX IF NOT EXISTS idx_assistant_channel_member_route_selection_expiry
  ON assistant_channel_member_route_selections (expires_at, tenant_id, space_id);

CREATE TABLE IF NOT EXISTS assistant_channel_member_route_selection_audit (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'whatsapp'),
  provider_route_key TEXT NOT NULL,
  sender_key TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN ('selected', 'cleared')),
  command_event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assistant_channel_member_route_selection_audit_scope
  ON assistant_channel_member_route_selection_audit (tenant_id, space_id, user_id, occurred_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_channel_member_route_selection_event
  ON assistant_channel_member_route_selection_audit (channel, provider_route_key, command_event_id);
