-- Telnyx Call Control identifiers are provider-opaque. Keep them separate from the internal
-- stable CA-prefixed live-call key used by the shared owner voice ticket/session machinery.
CREATE TABLE IF NOT EXISTS assistant_telnyx_live_calls (
  call_control_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id) ON DELETE CASCADE,
  live_call_id TEXT NOT NULL REFERENCES assistant_live_calls(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('answering','gathering','streaming','ended','indeterminate')),
  reserved_credits INTEGER NOT NULL DEFAULT 0 CHECK(reserved_credits>=0),
  stream_claimed INTEGER NOT NULL DEFAULT 0 CHECK(stream_claimed IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_telnyx_live_call_once ON assistant_telnyx_live_calls(live_call_id);
CREATE INDEX IF NOT EXISTS assistant_telnyx_live_active ON assistant_telnyx_live_calls(binding_id,state,updated_at);
ALTER TABLE assistant_live_calls ADD COLUMN reserved_credits INTEGER NOT NULL DEFAULT 0 CHECK(reserved_credits>=0);
ALTER TABLE assistant_telnyx_live_calls ADD COLUMN duration_seconds INTEGER;
ALTER TABLE assistant_telnyx_live_calls ADD COLUMN settled_credits INTEGER;
