-- Bounded per-call speech receipts and sequencing remain separate from OwnerVoice storage.
ALTER TABLE assistant_telnyx_extension_stream_sessions
  ADD COLUMN last_transcript_sequence INTEGER NOT NULL DEFAULT -1 CHECK(last_transcript_sequence BETWEEN -1 AND 1000000);

CREATE TABLE IF NOT EXISTS assistant_telnyx_extension_audio_usage (
  session_id TEXT NOT NULL REFERENCES assistant_telnyx_extension_stream_sessions(session_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 100),
  record_json TEXT NOT NULL CHECK(length(record_json)<=16384),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(session_id,request_id)
);
CREATE INDEX IF NOT EXISTS assistant_telnyx_extension_audio_usage_updated
  ON assistant_telnyx_extension_audio_usage(updated_at,session_id);
