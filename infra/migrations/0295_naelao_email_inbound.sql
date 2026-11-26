-- MS-32: Naelao Email inbound mail. Not applied remotely.
-- Message bodies are stored as text only; HTML is untrusted data and is never rendered server-side.
ALTER TABLE nemail_messages ADD COLUMN from_name TEXT;
ALTER TABLE nemail_messages ADD COLUMN cc_json TEXT;
ALTER TABLE nemail_messages ADD COLUMN text_body TEXT;
ALTER TABLE nemail_messages ADD COLUMN html_body TEXT;
ALTER TABLE nemail_attachments ADD COLUMN sha256 TEXT;
ALTER TABLE nemail_attachments ADD COLUMN disposition TEXT;

-- Fallback dedup: inbound mail without a Message-ID (including unparseable mail) is unique per raw hash within an inbox.
CREATE UNIQUE INDEX IF NOT EXISTS idx_nemail_messages_dedup_raw ON nemail_messages(inbox_id, raw_sha256)
  WHERE direction = 'inbound' AND message_id_header IS NULL AND raw_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nemail_messages_thread ON nemail_messages(nemail_tenant_id, thread_id, received_at);
CREATE INDEX IF NOT EXISTS idx_nemail_attachments_message ON nemail_attachments(nemail_tenant_id, message_id);

-- Internal event outbox read by the MS-34 webhook dispatcher. References only: no message content.
CREATE TABLE IF NOT EXISTS nemail_events (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  event_type TEXT NOT NULL,
  inbox_id TEXT NOT NULL REFERENCES nemail_inboxes(id),
  message_id TEXT REFERENCES nemail_messages(id),
  thread_id TEXT REFERENCES nemail_threads(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  dispatched_at TEXT,
  UNIQUE (event_type, message_id)
);
CREATE INDEX IF NOT EXISTS idx_nemail_events_pending ON nemail_events(created_at) WHERE dispatched_at IS NULL;
