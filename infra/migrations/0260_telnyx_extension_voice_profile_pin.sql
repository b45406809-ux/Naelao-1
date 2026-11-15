-- Pin the host-approved voice profile with each exact admitted call and consented stream.
ALTER TABLE assistant_telnyx_extension_calls
  ADD COLUMN extension_voice_profile_id TEXT NOT NULL DEFAULT 'economy-eve'
  CHECK(extension_voice_profile_id IN ('economy-eve','economy-ara','economy-rex','economy-sal','economy-leo'));

ALTER TABLE assistant_telnyx_extension_stream_sessions
  ADD COLUMN extension_voice_profile_id TEXT NOT NULL DEFAULT 'economy-eve'
  CHECK(extension_voice_profile_id IN ('economy-eve','economy-ara','economy-rex','economy-sal','economy-leo'));
