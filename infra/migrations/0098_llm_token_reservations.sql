-- Pre-dispatch LLM quota holds prevent concurrent builder chats from oversubscribing the
-- day/week/month token allowances. Holds never fabricate usage and expire if a run is abandoned.
CREATE TABLE IF NOT EXISTS llm_token_reservations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens > 0),
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','released','settled','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_token_reservations_org_status ON llm_token_reservations(org_id,status,expires_at,created_at);
CREATE INDEX IF NOT EXISTS idx_llm_token_reservations_run ON llm_token_reservations(org_id,run_id,status);
CREATE TABLE IF NOT EXISTS llm_token_run_settlements (
  org_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  actual_tokens INTEGER NOT NULL CHECK (actual_tokens >= 0),
  settled_at TEXT NOT NULL,
  PRIMARY KEY(org_id,run_id)
);
