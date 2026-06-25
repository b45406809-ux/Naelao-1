-- G-WH01..WH06: Outbound webhook subscriptions + delivery log
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events_json TEXT NOT NULL,                 -- JSON array of event names
  secret TEXT NOT NULL,                      -- HMAC signing secret (encrypted at rest)
  enabled INTEGER NOT NULL DEFAULT 1,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- 'pending', 'delivered', 'failed'
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_response_status INTEGER,
  last_response_body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  FOREIGN KEY (subscription_id) REFERENCES webhook_subscriptions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ws_space ON webhook_subscriptions (space_id, enabled);
CREATE INDEX IF NOT EXISTS idx_ws_tenant ON webhook_subscriptions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_wd_sub ON webhook_deliveries (subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wd_pending ON webhook_deliveries (status, next_attempt_at)
  WHERE status = 'pending';
