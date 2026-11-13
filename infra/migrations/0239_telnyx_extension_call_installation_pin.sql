-- Preserve the exact Space extension installation and handler admitted for each call.
-- Existing calls stay unpinned because the active assignment cannot prove their history.
ALTER TABLE assistant_telnyx_extension_calls ADD COLUMN extension_installation_id TEXT;
ALTER TABLE assistant_telnyx_extension_calls ADD COLUMN handler_sha256 TEXT;
CREATE INDEX IF NOT EXISTS assistant_telnyx_extension_calls_installation_recent
  ON assistant_telnyx_extension_calls(extension_installation_id,started_at DESC,call_control_id DESC);
