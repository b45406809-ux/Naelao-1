-- Conversation content belongs to the connected channel provider. Keep only provider IDs,
-- routing/trust metadata and timestamps in AgentPort; discard duplicate message bodies/files.
CREATE TABLE IF NOT EXISTS agentport_channel_message_refs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  provider_message_id TEXT,
  idempotency_key TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_id TEXT,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('owner','delegate','external','provider')),
  trust_level TEXT NOT NULL CHECK (trust_level IN ('verified','unverified')),
  status TEXT NOT NULL CHECK (status IN ('received','queued','sent','failed')),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id,channel_id,provider_message_id),
  UNIQUE (tenant_id,channel_id,idempotency_key),
  FOREIGN KEY (channel_id) REFERENCES agentport_channels(id),
  FOREIGN KEY (thread_id) REFERENCES agentport_threads(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_message_refs_thread
  ON agentport_channel_message_refs(tenant_id,thread_id,occurred_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agentport_action_receipts_authorization
  ON agentport_action_receipts(tenant_id,agent_id,authorization_ref) WHERE authorization_ref IS NOT NULL;

INSERT OR IGNORE INTO agentport_channel_message_refs
  (id,tenant_id,channel_id,thread_id,provider_message_id,idempotency_key,direction,sender_id,sender_role,trust_level,status,occurred_at,created_at)
SELECT id,tenant_id,channel_id,thread_id,provider_message_id,idempotency_key,direction,sender_id,sender_role,trust_level,
  CASE WHEN direction='outbound' AND status='queued' THEN 'failed' ELSE status END,occurred_at,created_at
FROM agentport_messages;

-- A deployment may replay this migration. Redact the legacy rows in place while keeping the
-- existing relationship/idempotency metadata for erasure and duplicate detection.
UPDATE agentport_messages
SET content_text=NULL,content_ref=NULL,attachments_json='[]',
  status=CASE WHEN direction='outbound' AND status='queued' THEN 'failed' ELSE status END;

-- Replace internal message IDs in legacy event pointers with the provider-native message ID.
-- No event payload or attachment data is copied into the event inbox.
UPDATE agentport_events
SET payload_ref=(SELECT r.provider_message_id FROM agentport_channel_message_refs r
  WHERE 'agentport-message:'||r.id=agentport_events.payload_ref LIMIT 1)
WHERE payload_ref LIKE 'agentport-message:%';

