-- Public Telnyx extension media sessions are separately scoped from OwnerVoice. Tickets are
-- one-use bearer secrets stored only as hashes, and sessions retain the exact published handler pin.
CREATE TABLE IF NOT EXISTS assistant_telnyx_extension_stream_sessions (
  session_id TEXT PRIMARY KEY CHECK(length(session_id) BETWEEN 16 AND 80),
  call_ref TEXT NOT NULL UNIQUE CHECK(length(call_ref)=37 AND substr(call_ref,1,5)='call_'),
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id) ON DELETE CASCADE,
  call_control_id TEXT NOT NULL UNIQUE REFERENCES assistant_telnyx_extension_calls(call_control_id) ON DELETE CASCADE,
  extension_installation_id TEXT NOT NULL,
  handler_sha256 TEXT NOT NULL CHECK(length(handler_sha256)=64),
  settings_revision INTEGER CHECK(settings_revision IS NULL OR settings_revision>=0),
  consent_state TEXT NOT NULL CHECK(consent_state IN ('pending','granted','denied','revoked')),
  state TEXT NOT NULL CHECK(state IN ('consent_pending','ready','claimed','active','ended','indeterminate')),
  media_ticket_sha256 TEXT CHECK(media_ticket_sha256 IS NULL OR length(media_ticket_sha256)=64),
  ticket_expires_at INTEGER,
  ticket_claimed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(ticket_expires_at IS NULL OR ticket_expires_at<=expires_at)
);
CREATE INDEX IF NOT EXISTS assistant_telnyx_extension_stream_sessions_ready
  ON assistant_telnyx_extension_stream_sessions(binding_id,state,ticket_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_telnyx_extension_stream_sessions_ticket
  ON assistant_telnyx_extension_stream_sessions(media_ticket_sha256) WHERE media_ticket_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS assistant_telnyx_extension_stream_sessions_scope
  ON assistant_telnyx_extension_stream_sessions(tenant_id,space_id,project_id,state,updated_at);
