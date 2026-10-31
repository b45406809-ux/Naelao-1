-- Run-scoped OpenRouter Decisions API holds. Uncertain attempts remain held for reconciliation.
CREATE TABLE IF NOT EXISTS decision_call_reservations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT,
  run_id TEXT NOT NULL, model_id TEXT NOT NULL, price_snapshot TEXT NOT NULL,
  input_usd_per_token REAL NOT NULL CHECK(input_usd_per_token >= 0), output_usd_per_token REAL NOT NULL CHECK(output_usd_per_token >= 0),
  max_tokens INTEGER NOT NULL CHECK(max_tokens > 0), max_credits INTEGER NOT NULL CHECK(max_credits > 0),
  status TEXT NOT NULL CHECK(status IN ('held','uncertain','settled','released')), actual_tokens INTEGER, cost_credits INTEGER, rate_card_version TEXT,
  created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(org_id, run_id, id),
  FOREIGN KEY(space_id) REFERENCES spaces(id) ON DELETE CASCADE,
  FOREIGN KEY(org_id) REFERENCES orgs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_decision_call_reservations_run ON decision_call_reservations(org_id,run_id,status);
CREATE INDEX IF NOT EXISTS idx_decision_call_reservations_status ON decision_call_reservations(status,updated_at);
