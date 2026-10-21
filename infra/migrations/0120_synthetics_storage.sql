CREATE TABLE IF NOT EXISTS synthetic_results (
  id TEXT PRIMARY KEY,
  check_name TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_synthetic_results_created_at
  ON synthetic_results (created_at);

CREATE TABLE IF NOT EXISTS synthetic_check_state (
  check_name TEXT PRIMARY KEY,
  failure_active INTEGER NOT NULL CHECK (failure_active IN (0, 1)),
  updated_at TEXT NOT NULL
);
