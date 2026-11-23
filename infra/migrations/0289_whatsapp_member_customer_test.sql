-- Short-lived, explicit customer tests from a member's already verified WhatsApp contact.
-- Destination and sender identities are keyed by HMAC; raw codes are never persisted.
CREATE TABLE IF NOT EXISTS assistant_channel_member_customer_test_challenges (
  challenge_hash TEXT PRIMARY KEY,
  test_session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'whatsapp'),
  provider_route_key TEXT NOT NULL,
  sender_key TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  package_version TEXT NOT NULL,
  handler_sha256 TEXT NOT NULL CHECK (length(handler_sha256) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_event_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_customer_test_challenge_scope
  ON assistant_channel_member_customer_test_challenges
    (tenant_id, space_id, user_id, project_id, installation_id, expires_at);

CREATE TABLE IF NOT EXISTS assistant_channel_member_customer_test_sessions (
  test_session_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'whatsapp'),
  provider_route_key TEXT NOT NULL,
  sender_key TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  package_version TEXT NOT NULL,
  handler_sha256 TEXT NOT NULL CHECK (length(handler_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('active', 'exited', 'expired', 'revoked')),
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT CHECK (ended_reason IS NULL OR ended_reason IN ('member_exit', 'member_revoked', 'access_changed', 'expired')),
  started_event_key TEXT NOT NULL,
  ended_event_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_customer_test_one_active_sender
  ON assistant_channel_member_customer_test_sessions (channel, provider_route_key, sender_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_whatsapp_customer_test_member_scope
  ON assistant_channel_member_customer_test_sessions
    (tenant_id, space_id, user_id, project_id, installation_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_whatsapp_customer_test_event_keys
  ON assistant_channel_member_customer_test_sessions (provider_route_key, started_event_key, ended_event_key);
