-- Self-verified WhatsApp contacts are independent of executive_contacts and customer channel_pairings.
-- sender_key and provider_route_key are HMACs, so provider phone numbers and account IDs are not
-- stored in this identity map. The same sender can hold separate member bindings in several Spaces.
CREATE TABLE IF NOT EXISTS assistant_channel_member_contacts (
  contact_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'whatsapp'),
  provider_route_key TEXT NOT NULL,
  sender_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'replaced', 'revoked')),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_channel_member_contact_user_active
  ON assistant_channel_member_contacts (tenant_id, space_id, channel, user_id, provider_route_key)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_channel_member_contact_sender_active
  ON assistant_channel_member_contacts (tenant_id, space_id, channel, provider_route_key, sender_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_assistant_channel_member_contact_lookup
  ON assistant_channel_member_contacts (channel, provider_route_key, sender_key, status, tenant_id, space_id);

CREATE TABLE IF NOT EXISTS assistant_channel_member_contact_challenges (
  challenge_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'whatsapp'),
  provider_route_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  sender_key TEXT,
  consumed_event_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_assistant_channel_member_contact_challenge_scope
  ON assistant_channel_member_contact_challenges (tenant_id, space_id, user_id, channel, expires_at);

CREATE TABLE IF NOT EXISTS assistant_channel_member_contact_audit (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'whatsapp'),
  provider_route_key TEXT NOT NULL,
  sender_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('verified', 'replaced', 'revoked')),
  actor_user_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assistant_channel_member_contact_audit_scope
  ON assistant_channel_member_contact_audit (tenant_id, space_id, user_id, occurred_at);
