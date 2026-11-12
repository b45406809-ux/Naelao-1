-- AgentMail owns all mailbox content. Naelao stores only account/inbox references,
-- provider credentials encrypted at rest, and billing lifecycle metadata.
CREATE TABLE IF NOT EXISTS assistant_agentmail_pods (
  tenant_id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('active','failed','suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_agentmail_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  assistant_identity_id TEXT NOT NULL,
  agentport_agent_id TEXT NOT NULL,
  agentport_account_id TEXT,
  owner_user_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('naelao_managed','user_connected')),
  pod_id TEXT,
  inbox_id TEXT NOT NULL,
  email_address TEXT NOT NULL,
  credential_ciphertext TEXT,
  credential_iv TEXT,
  agentmail_webhook_id TEXT,
  agentmail_webhook_secret_ciphertext TEXT,
  agentmail_webhook_secret_iv TEXT,
  agentport_subscription_id TEXT,
  agentport_webhook_secret_ciphertext TEXT,
  agentport_webhook_secret_iv TEXT,
  status TEXT NOT NULL CHECK(status IN ('provisioning','active','billing_hold','retirement_review_required','retired','failed')),
  activated_at TEXT,
  next_billing_at TEXT,
  retire_after TEXT,
  delete_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK(delete_at_period_end IN (0,1)),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_agentmail_due ON assistant_agentmail_accounts(mode,status,next_billing_at);
CREATE INDEX IF NOT EXISTS idx_assistant_agentmail_space ON assistant_agentmail_accounts(tenant_id,space_id,project_id,status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_agentmail_agent_inbox ON assistant_agentmail_accounts(tenant_id,agentport_agent_id,inbox_id);

CREATE TABLE IF NOT EXISTS assistant_agentmail_event_receipts (
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message_ref TEXT,
  thread_ref TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','queued','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id,event_id)
);
CREATE TABLE IF NOT EXISTS assistant_agentmail_sends (
  connection_id TEXT NOT NULL,
  idempotency_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sending','sent','indeterminate')),
  provider_message_id TEXT,
  first_attempt_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(connection_id,idempotency_hash)
);
CREATE INDEX IF NOT EXISTS idx_assistant_agentmail_sends_daily ON assistant_agentmail_sends(connection_id,status,first_attempt_at);
CREATE TABLE IF NOT EXISTS assistant_agentport_event_receipts (
  delivery_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','queued','failed')),
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_agentport_event_receipts_pending ON assistant_agentport_event_receipts(status,updated_at);
CREATE TABLE IF NOT EXISTS assistant_agentport_event_runs (
  delivery_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  agent_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  thread_ref TEXT NOT NULL,
  data_ref TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','running','accepted','failed')),
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS assistant_agentmail_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  assistant_identity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('provision','renew','switch','retire')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','complete','held','failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  error_code TEXT,
  result_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
