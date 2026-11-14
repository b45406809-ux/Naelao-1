-- Keep a bounded, release-pinned record for public Twilio extension calls.
-- Historical calls remain unpinned because their former installation cannot be inferred.
ALTER TABLE assistant_phone_events ADD COLUMN extension_installation_id TEXT;
ALTER TABLE assistant_phone_events ADD COLUMN handler_sha256 TEXT;
CREATE INDEX assistant_phone_events_extension_call_recent
  ON assistant_phone_events(binding_id,created_at DESC,id DESC)
  WHERE kind='call' AND extension_installation_id IS NOT NULL;
