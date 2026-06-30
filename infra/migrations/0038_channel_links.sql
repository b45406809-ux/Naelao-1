-- Multi-channel gateway: which spaces have which channels configured. Discovery roster for
-- the heartbeat cron sweep (mirrors the mcp_servers join the connector poller uses) — the
-- channel's signing secret itself lives in the encrypted credentials vault, never here.
CREATE TABLE IF NOT EXISTS channel_links (
  space_id   TEXT NOT NULL,
  tenant_id  TEXT NOT NULL,
  channel    TEXT NOT NULL, -- 'slack' | 'discord' | 'email'
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (space_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_channel_links_enabled ON channel_links(enabled, channel);
