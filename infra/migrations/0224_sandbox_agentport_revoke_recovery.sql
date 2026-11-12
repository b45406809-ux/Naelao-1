-- Preserve exact AgentPort targets and lease uncertain Agent37 account revocations.
ALTER TABLE sandbox_agentport_operations ADD COLUMN request_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sandbox_agentport_operations ADD COLUMN lease_until TEXT;
ALTER TABLE sandbox_agentport_operations ADD COLUMN next_reconcile_at TEXT;
ALTER TABLE sandbox_agentport_operations ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK(reconcile_attempts >= 0);

CREATE INDEX IF NOT EXISTS idx_sandbox_agentport_operations_revoke_due
  ON sandbox_agentport_operations(operation, status, next_reconcile_at, lease_until);
