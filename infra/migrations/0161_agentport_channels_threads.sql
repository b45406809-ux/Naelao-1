-- Provider-neutral channel identities and message threads. Session bindings are opaque references
-- supplied by a runtime; AgentPort never owns or creates Naelao sessions.
CREATE TABLE IF NOT EXISTS agentport_service_manifests (
  tenant_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  provisioning_json TEXT NOT NULL DEFAULT '{}',
  capability_schemas_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,service_id),
  FOREIGN KEY (service_id) REFERENCES agentport_services(id)
);

CREATE TABLE IF NOT EXISTS agentport_channels (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider_channel_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  trust_policy_json TEXT NOT NULL DEFAULT '{"publicReplies":false,"publicMemoryUpdates":false,"commandMode":"owner_only","authenticationMode":"basic"}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, service_id, provider_channel_id),
  FOREIGN KEY (service_id) REFERENCES agentport_services(id),
  FOREIGN KEY (account_id) REFERENCES agentport_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_channels_account ON agentport_channels(tenant_id,account_id,status);

CREATE TABLE IF NOT EXISTS agentport_threads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  provider_thread_id TEXT NOT NULL,
  participants_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  session_binding_json TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','closed')),
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id,channel_id,provider_thread_id),
  FOREIGN KEY (channel_id) REFERENCES agentport_channels(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_threads_recent ON agentport_threads(tenant_id,channel_id,last_message_at);

CREATE TABLE IF NOT EXISTS agentport_messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  provider_message_id TEXT,
  idempotency_key TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_id TEXT,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('owner','delegate','external','provider')),
  trust_level TEXT NOT NULL CHECK (trust_level IN ('verified','unverified')),
  content_text TEXT,
  content_ref TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','queued','sent','failed')),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id,channel_id,provider_message_id),
  UNIQUE (tenant_id,channel_id,idempotency_key),
  FOREIGN KEY (channel_id) REFERENCES agentport_channels(id),
  FOREIGN KEY (thread_id) REFERENCES agentport_threads(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_messages_thread ON agentport_messages(tenant_id,thread_id,occurred_at,id);

-- A provider-authenticated sender identifier can be linked to an owner or delegate. A display
-- name, phone number in message text, or claim made by the model is never trusted as identity.
CREATE TABLE IF NOT EXISTS agentport_trusted_senders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  provider_sender_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','delegate')),
  principal_id TEXT NOT NULL,
  authentication_mode TEXT NOT NULL DEFAULT 'basic' CHECK (authentication_mode IN ('basic','stepup','strict')),
  allowed_actions_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id,channel_id,provider_sender_id),
  FOREIGN KEY (channel_id) REFERENCES agentport_channels(id)
);

CREATE TABLE IF NOT EXISTS agentport_action_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  account_id TEXT,
  channel_id TEXT,
  action TEXT NOT NULL,
  resource_ref TEXT,
  authorization_ref TEXT,
  provider_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed','denied','pending_approval','succeeded','failed','reversed')),
  reason_code TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  previous_hash TEXT,
  receipt_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agentport_agents(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_action_receipts_agent ON agentport_action_receipts(tenant_id,agent_id,created_at);

-- Promote legacy Cloudflare email aliases to channels without changing their hashed address,
-- account, creator, agent, project, tenant, or active/revoked status relationships.
INSERT OR IGNORE INTO agentport_channels
  (id,tenant_id,service_id,account_id,provider_channel_id,display_name,status,created_at,updated_at)
SELECT 'chn-email-alias:'||a.tenant_id||':'||a.address_hash,a.tenant_id,'svc-email-routing:'||a.tenant_id,
  'acct-email-alias:'||a.address_hash,a.address_hash,'Legacy AgentPort mail alias',
  CASE a.status WHEN 'active' THEN 'active' ELSE 'revoked' END,a.created_at,a.created_at
FROM agent_email_addresses a JOIN agentport_accounts acct ON acct.id='acct-email-alias:'||a.address_hash AND acct.tenant_id=a.tenant_id;

INSERT OR IGNORE INTO agentport_channels
  (id,tenant_id,service_id,account_id,provider_channel_id,display_name,status,created_at,updated_at)
SELECT 'chn-email-project-alias:'||a.tenant_id||':'||a.address_hash,a.tenant_id,'svc-email-routing:'||a.tenant_id,
  'acct-email-project-alias:'||a.address_hash,a.address_hash,'Legacy AgentPort project mail alias',
  CASE a.status WHEN 'active' THEN 'active' ELSE 'revoked' END,a.created_at,a.created_at
FROM project_agent_email_addresses a JOIN agentport_accounts acct ON acct.id='acct-email-project-alias:'||a.address_hash AND acct.tenant_id=a.tenant_id;
