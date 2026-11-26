-- MS-45 / MR-EXE-1 step 8: outcome receipts (`succeeded`, `failed`, `uncertain`) are appended to agentport_action_receipts,
-- chained per tenant and agent by previous_hash. The original CHECK allowed no `uncertain` outcome, and SQLite cannot alter a CHECK,
-- so the table is rebuilt with the same columns, rows and indexes. Not applied remotely by the task that added it.
CREATE TABLE agentport_action_receipts_v2 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  account_id TEXT,
  channel_id TEXT,
  action TEXT NOT NULL,
  resource_ref TEXT,
  authorization_ref TEXT,
  provider_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed','denied','pending_approval','succeeded','failed','uncertain','reversed')),
  reason_code TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  previous_hash TEXT,
  receipt_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agentport_agents(id)
);
INSERT INTO agentport_action_receipts_v2(id,tenant_id,agent_id,account_id,channel_id,action,resource_ref,authorization_ref,provider_id,outcome,reason_code,details_json,previous_hash,receipt_hash,created_at)
  SELECT id,tenant_id,agent_id,account_id,channel_id,action,resource_ref,authorization_ref,provider_id,outcome,reason_code,details_json,previous_hash,receipt_hash,created_at
  FROM agentport_action_receipts ORDER BY rowid;
DROP TABLE agentport_action_receipts;
ALTER TABLE agentport_action_receipts_v2 RENAME TO agentport_action_receipts;
CREATE INDEX IF NOT EXISTS idx_agentport_action_receipts_agent ON agentport_action_receipts(tenant_id,agent_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agentport_action_receipts_authorization
  ON agentport_action_receipts(tenant_id,agent_id,authorization_ref) WHERE authorization_ref IS NOT NULL;
