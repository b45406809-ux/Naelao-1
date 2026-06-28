-- G-TG01..TG06: Automation triggers (schedule, webhook, event-based)
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,    -- 'cron', 'webhook', 'event', 'inbound_channel'
  config_json TEXT NOT NULL,     -- type-specific config (cron expr, event names, etc.)
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at TEXT,
  fire_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_triggers_space ON triggers (space_id, enabled);
CREATE INDEX IF NOT EXISTS idx_triggers_tenant ON triggers (tenant_id);
