-- Public extension call sessions are separate from authenticated owner live calls.
-- They retain only the provider call binding and bounded lifecycle metadata; extension
-- conversation state remains in the extension-scoped SpaceDO session store.
CREATE TABLE IF NOT EXISTS assistant_telnyx_extension_calls (
  call_control_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id) ON DELETE CASCADE,
  caller TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('answering','processing','gathering','finishing','ended','indeterminate')),
  turn_count INTEGER NOT NULL DEFAULT 0 CHECK(turn_count BETWEEN 0 AND 20),
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  duration_seconds INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_telnyx_extension_calls_active
  ON assistant_telnyx_extension_calls(binding_id,state,updated_at);
