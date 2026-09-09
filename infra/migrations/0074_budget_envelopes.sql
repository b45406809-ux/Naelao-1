-- Migration 0074: Per-User Daily Budget Envelopes
CREATE TABLE IF NOT EXISTS space_user_budget_envelopes (
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  daily_credit_allowance INTEGER NOT NULL DEFAULT 500, -- 500 credits = $5.00 USD
  credits_spent_today INTEGER NOT NULL DEFAULT 0,
  hard_stop_enabled INTEGER NOT NULL DEFAULT 1,
  warned_at_eighty INTEGER NOT NULL DEFAULT 0,         -- Boolean flag for 80% threshold alert
  reset_at TEXT NOT NULL DEFAULT (datetime('now', '+1 day')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (space_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sube_reset ON space_user_budget_envelopes(reset_at);
CREATE INDEX IF NOT EXISTS idx_sube_space_user ON space_user_budget_envelopes(space_id, user_id);
