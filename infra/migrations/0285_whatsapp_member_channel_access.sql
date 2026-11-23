-- Admin-controlled WhatsApp access is separate from provider pairing and executive contacts.
-- An empty project_id grants only the Space assistant route; a project id grants that exact
-- Project route. Member contact proof is stored separately after the member completes a challenge.
CREATE TABLE IF NOT EXISTS assistant_channel_member_access (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'whatsapp'),
  project_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('enabled', 'suspended', 'revoked')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, space_id, channel, user_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_assistant_channel_member_access_lookup
  ON assistant_channel_member_access (channel, user_id, status, tenant_id, space_id);

CREATE TABLE IF NOT EXISTS assistant_channel_member_access_audit (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'whatsapp'),
  project_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('enabled', 'suspended', 'revoked')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  actor_user_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_channel_member_access_audit_scope
  ON assistant_channel_member_access_audit (tenant_id, space_id, user_id, occurred_at);
