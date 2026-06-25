-- G-AGI01..AGI08: Mini-AGI hierarchical agent orchestration run tracking
CREATE TABLE IF NOT EXISTS agi_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending', 'planning', 'running', 'completed', 'failed', 'cancelled'
  token_budget INTEGER NOT NULL DEFAULT 50000,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  depth_limit INTEGER NOT NULL DEFAULT 3,
  result_json TEXT,
  error TEXT,
  cancelled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agi_subtasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_id TEXT,
  description TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending', 'running', 'completed', 'failed'
  agent_session_id TEXT,
  result TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES agi_runs (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agi_runs_tenant ON agi_runs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agi_subtasks_run ON agi_subtasks (run_id, depth, parent_id);
