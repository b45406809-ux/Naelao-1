-- Migration 0074: Cryptographic Provenance Ledger & On-Call Routing

-- 1. Immutable Audit Ledger for Regulated Enterprise Compliance
CREATE TABLE IF NOT EXISTS provenance_ledger (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  project_id TEXT,
  action_id TEXT NOT NULL,
  human_user_id TEXT NOT NULL,
  jwt_session_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  agent_executor_id TEXT NOT NULL,
  action_type TEXT NOT NULL,             -- e.g. "FILE_EDIT", "GIT_COMMIT", "CREDENTIAL_RESOLVE"
  action_payload_hash TEXT NOT NULL,     -- SHA-256 of the execution payload
  git_commit_sha TEXT,
  gatekeeper_token_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prov_space ON provenance_ledger(space_id, project_id);
CREATE INDEX IF NOT EXISTS idx_prov_user ON provenance_ledger(human_user_id);
CREATE INDEX IF NOT EXISTS idx_prov_action ON provenance_ledger(action_id);

-- 2. Single On-Call Routing Table
CREATE TABLE IF NOT EXISTS project_on_call_leads (
  project_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  lead_user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
