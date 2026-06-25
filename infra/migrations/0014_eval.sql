-- G-EV01..EV08: Eval suites and results for SpaceType quality testing
CREATE TABLE IF NOT EXISTS eval_suites (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  cases_json TEXT NOT NULL DEFAULT '[]',     -- [{input, expected_output, judge_criteria}]
  model TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- 'pending', 'running', 'completed', 'failed'
  total_cases INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  suite_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  case_index INTEGER NOT NULL,
  input TEXT NOT NULL,
  expected_output TEXT,
  actual_output TEXT,
  passed INTEGER NOT NULL DEFAULT 0,
  score REAL,
  judge_reasoning TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES eval_runs (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_eval_suites_space ON eval_suites (space_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_suite ON eval_runs (suite_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results (run_id, case_index);
