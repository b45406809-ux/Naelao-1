-- Operator observations are evidence records, not capabilities by themselves. The verifier
-- joins these observations to the current computer, allocation, authorization and reservations.
CREATE TABLE IF NOT EXISTS workspace_live_runtime_observations (
  runtime_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  allocation_generation INTEGER NOT NULL CHECK(allocation_generation > 0),
  runtime_type TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_digest TEXT NOT NULL CHECK(template_digest GLOB 'sha256:*'),
  region TEXT NOT NULL,
  residency_policy_id TEXT NOT NULL,
  capability_observations_json TEXT NOT NULL,
  billing_reservation_id TEXT NOT NULL,
  budget_reservation_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(runtime_id, allocation_id, allocation_generation)
);
CREATE INDEX IF NOT EXISTS idx_live_runtime_observations_current
  ON workspace_live_runtime_observations(runtime_id, allocation_generation, revoked_at, valid_until);

CREATE TABLE IF NOT EXISTS workspace_live_runtime_observation_audit (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  allocation_generation INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('observed','revoked')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_runtime_observation_audit
  ON workspace_live_runtime_observation_audit(runtime_id, allocation_generation, created_at);
