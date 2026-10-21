-- Persist scan positions so a permanently failing cleanup item cannot starve later rows.
CREATE TABLE IF NOT EXISTS sweeper_cursors (
  name TEXT PRIMARY KEY,
  cursor_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
