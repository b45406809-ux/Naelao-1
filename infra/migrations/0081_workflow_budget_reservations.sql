-- Durable pre-dispatch holds for long-running workflow budgets. Holds are separate from
-- usage_events: a retry or cancellation can release capacity without fabricating usage.
CREATE TABLE IF NOT EXISTS workflow_budget_reservations (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  space_id      TEXT NOT NULL,
  workflow_id   TEXT NOT NULL UNIQUE,
  budget_key    TEXT NOT NULL,
  credits       INTEGER NOT NULL CHECK (credits > 0),
  status        TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','released','settled')),
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_budget_org_status ON workflow_budget_reservations(org_id, status, expires_at);
