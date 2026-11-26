-- MS-34: Naelao Email signed webhooks, retry and dead-letter. Not applied remotely.

-- nemail_events (0295) was unique on (event_type, message_id). One outbound message has one delivery
-- event per recipient, so delivery events are keyed by delivery too. Rebuild the outbox (table is only
-- written by the inbound and send paths, which are flag-off until enablement).
CREATE TABLE nemail_events_v2 (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('email.message.received','email.delivery.sent','email.delivery.failed','email.delivery.bounced','email.delivery.complained')),
  inbox_id TEXT NOT NULL REFERENCES nemail_inboxes(id),
  message_id TEXT REFERENCES nemail_messages(id),
  thread_id TEXT REFERENCES nemail_threads(id),
  delivery_id TEXT REFERENCES nemail_deliveries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  dispatched_at TEXT
);
INSERT INTO nemail_events_v2 (id, nemail_tenant_id, event_type, inbox_id, message_id, thread_id, created_at, dispatched_at)
  SELECT id, nemail_tenant_id, event_type, inbox_id, message_id, thread_id, created_at, dispatched_at FROM nemail_events;
DROP TABLE nemail_events;
ALTER TABLE nemail_events_v2 RENAME TO nemail_events;
CREATE UNIQUE INDEX IF NOT EXISTS idx_nemail_events_unique ON nemail_events(event_type, COALESCE(message_id, ''), COALESCE(delivery_id, ''));
CREATE INDEX IF NOT EXISTS idx_nemail_events_pending ON nemail_events(created_at) WHERE dispatched_at IS NULL;

-- One row per (webhook, event). The dispatcher fans events out here; next_attempt_at drives retries.
-- claimed_until is a short lease so overlapping cron runs never post the same delivery concurrently.
CREATE TABLE IF NOT EXISTS nemail_webhook_deliveries (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  webhook_id TEXT NOT NULL REFERENCES nemail_webhooks(id),
  event_id TEXT NOT NULL REFERENCES nemail_events(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','dead_letter','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TEXT,
  next_attempt_at TEXT NOT NULL,
  claimed_until TEXT,
  last_status_code INTEGER,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_nemail_webhook_deliveries_due ON nemail_webhook_deliveries(next_attempt_at) WHERE status = 'pending';

-- One row per HTTP attempt. Stores status and error code only, never the request body or the secret.
CREATE TABLE IF NOT EXISTS nemail_webhook_attempts (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  delivery_id TEXT NOT NULL REFERENCES nemail_webhook_deliveries(id),
  attempt_no INTEGER NOT NULL,
  attempted_at TEXT NOT NULL,
  status_code INTEGER,
  error_code TEXT,
  UNIQUE (delivery_id, attempt_no)
);
