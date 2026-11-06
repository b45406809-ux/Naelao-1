-- AgentPort resource registry. Provider IDs are references, not canonical agent identity.
-- Connection purposes keep user delegation, agent resources and parent provisioning distinct.
CREATE TABLE IF NOT EXISTS agentport_principals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('individual','organization','platform')),
  external_id TEXT NOT NULL,
  verification_level TEXT NOT NULL DEFAULT 'unverified',
  verification_issuer TEXT,
  verification_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, principal_type, external_id)
);

CREATE TABLE IF NOT EXISTS agentport_agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  host_platform TEXT NOT NULL,
  host_space_id TEXT,
  runtime TEXT,
  public_key_set TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, host_platform, host_space_id, id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_agents_principal ON agentport_agents(tenant_id, principal_id, status);

CREATE TABLE IF NOT EXISTS agentport_services (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  service_type TEXT NOT NULL CHECK (service_type IN ('api','mcp','a2a','channel','managed')),
  endpoint TEXT,
  account_models_json TEXT NOT NULL DEFAULT '[]',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  events_json TEXT NOT NULL DEFAULT '[]',
  billing_json TEXT NOT NULL DEFAULT '{}',
  connection_purpose TEXT NOT NULL CHECK (connection_purpose IN ('user_delegation','agent_resource','parent_provisioning')),
  partnership_status TEXT NOT NULL DEFAULT 'unaffiliated' CHECK (partnership_status IN ('unaffiliated','approved','restricted','unavailable')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS agentport_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  account_model TEXT NOT NULL CHECK (account_model IN ('agent_native','user_parent','agentport_parent','delegated')),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('individual','organization','agentport','provider')),
  owner_id TEXT NOT NULL,
  parent_account_id TEXT,
  external_account_id TEXT,
  credential_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','revoked','failed')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (service_id) REFERENCES agentport_services(id),
  FOREIGN KEY (parent_account_id) REFERENCES agentport_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_accounts_owner ON agentport_accounts(tenant_id, owner_type, owner_id, status);
CREATE INDEX IF NOT EXISTS idx_agentport_accounts_parent ON agentport_accounts(tenant_id, parent_account_id);

CREATE TABLE IF NOT EXISTS agentport_account_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, account_id, agent_id),
  FOREIGN KEY (account_id) REFERENCES agentport_accounts(id),
  FOREIGN KEY (agent_id) REFERENCES agentport_agents(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_grants_agent ON agentport_account_grants(tenant_id, agent_id, status);

CREATE TABLE IF NOT EXISTS agentport_account_dependencies (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  depends_on_account_id TEXT NOT NULL,
  dependency_type TEXT NOT NULL CHECK (dependency_type IN ('provisioning','authentication','billing','recovery','runtime')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, account_id, depends_on_account_id, dependency_type),
  CHECK (account_id != depends_on_account_id),
  FOREIGN KEY (account_id) REFERENCES agentport_accounts(id),
  FOREIGN KEY (depends_on_account_id) REFERENCES agentport_accounts(id)
);

CREATE TABLE IF NOT EXISTS agentport_event_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  account_id TEXT,
  event_type TEXT NOT NULL,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('webhook','poll','naelao','mcp')),
  consumer_group TEXT,
  routing_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, agent_id, service_id, event_type, consumer_group),
  FOREIGN KEY (agent_id) REFERENCES agentport_agents(id),
  FOREIGN KEY (service_id) REFERENCES agentport_services(id),
  FOREIGN KEY (account_id) REFERENCES agentport_accounts(id)
);

CREATE TABLE IF NOT EXISTS agentport_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  account_id TEXT,
  provider_event_id TEXT,
  event_type TEXT NOT NULL,
  thread_ref TEXT,
  payload_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','delivered','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, service_id, provider_event_id),
  FOREIGN KEY (service_id) REFERENCES agentport_services(id),
  FOREIGN KEY (account_id) REFERENCES agentport_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_events_pending ON agentport_events(tenant_id, status, available_at);

-- Each subscription receives its own delivery record so shared accounts can fan out or be
-- consumed independently. Claims are leases and stale consumers are automatically retryable.
CREATE TABLE IF NOT EXISTS agentport_event_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','delivered','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_owner TEXT,
  claim_expires_at TEXT,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, event_id, subscription_id),
  FOREIGN KEY (event_id) REFERENCES agentport_events(id),
  FOREIGN KEY (subscription_id) REFERENCES agentport_event_subscriptions(id),
  FOREIGN KEY (agent_id) REFERENCES agentport_agents(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_deliveries_pending ON agentport_event_deliveries(tenant_id, agent_id, status, available_at);

-- Leases track temporary event-consumer ownership only. They do not lock accounts against use.
CREATE TABLE IF NOT EXISTS agentport_activity_leases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'event_consumer' CHECK (purpose = 'event_consumer'),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, subscription_id, consumer_id),
  FOREIGN KEY (agent_id) REFERENCES agentport_agents(id),
  FOREIGN KEY (subscription_id) REFERENCES agentport_event_subscriptions(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_leases_expiry ON agentport_activity_leases(tenant_id, subscription_id, expires_at);

-- Backfill the existing Cloudflare Email Routing aliases without deleting or rewriting their
-- source rows. The address hash is the only mailbox identifier retained by the old tables; keep
-- it opaque and preserve tenant/space/agent/project/status relationships. Principals imported
-- from a Naelao space creator are explicitly unverified.
INSERT OR IGNORE INTO agentport_services
  (id,tenant_id,name,service_type,account_models_json,capabilities_json,events_json,connection_purpose,partnership_status,created_at,updated_at)
SELECT 'svc-email-routing:'||tenant_id,tenant_id,'Naelao Cloudflare Email Routing','managed',
  '["agent_native","agentport_parent"]','["email.receive"]','["message.received"]','agent_resource','unaffiliated',datetime('now'),datetime('now')
FROM (
  SELECT tenant_id FROM agent_email_addresses
  UNION
  SELECT tenant_id FROM project_agent_email_addresses
);

INSERT OR IGNORE INTO agentport_principals
  (id,tenant_id,principal_type,external_id,verification_level,created_at,updated_at)
SELECT 'prn-user:'||s.tenant_id||':'||s.created_by,s.tenant_id,'individual',s.created_by,'unverified',datetime('now'),datetime('now')
FROM spaces s
WHERE s.created_by IS NOT NULL AND EXISTS (
  SELECT 1 FROM agent_email_addresses a WHERE a.tenant_id=s.tenant_id AND a.space_id=s.id
  UNION ALL
  SELECT 1 FROM project_agent_email_addresses a WHERE a.tenant_id=s.tenant_id AND a.space_id=s.id
);

INSERT OR IGNORE INTO agentport_agents
  (id,tenant_id,principal_id,created_by,host_platform,host_space_id,status,created_at,updated_at)
SELECT DISTINCT 'naelao:'||a.tenant_id||':'||a.space_id||':'||a.agent_id,a.tenant_id,
  'prn-user:'||a.tenant_id||':'||s.created_by,s.created_by,'naelao',a.space_id,'active',a.created_at,a.created_at
FROM agent_email_addresses a JOIN spaces s ON s.id=a.space_id AND s.tenant_id=a.tenant_id
WHERE s.created_by IS NOT NULL
UNION
SELECT DISTINCT 'naelao:'||a.tenant_id||':'||a.space_id||':'||a.agent_id,a.tenant_id,
  'prn-user:'||a.tenant_id||':'||s.created_by,s.created_by,'naelao',a.space_id,'active',a.created_at,a.created_at
FROM project_agent_email_addresses a JOIN spaces s ON s.id=a.space_id AND s.tenant_id=a.tenant_id
WHERE s.created_by IS NOT NULL;

-- The root represents the AgentPort-managed routing domain relationship, not a provider-issued
-- independent mailbox. The alias is a child resource and remains a logical address only.
INSERT OR IGNORE INTO agentport_accounts
  (id,tenant_id,service_id,account_model,owner_type,owner_id,status,metadata_json,created_at,updated_at)
SELECT 'acct-email-domain:'||tenant_id,tenant_id,'svc-email-routing:'||tenant_id,'agent_native','agentport',tenant_id,'active',
  '{"resource":"routing-domain-parent"}',datetime('now'),datetime('now')
FROM (
  SELECT tenant_id FROM agent_email_addresses
  UNION
  SELECT tenant_id FROM project_agent_email_addresses
);

INSERT OR IGNORE INTO agentport_accounts
  (id,tenant_id,service_id,account_model,owner_type,owner_id,parent_account_id,external_account_id,status,metadata_json,created_at,updated_at)
SELECT 'acct-email-alias:'||a.address_hash,a.tenant_id,'svc-email-routing:'||a.tenant_id,'agentport_parent','individual',
  'prn-user:'||a.tenant_id||':'||s.created_by,'acct-email-domain:'||a.tenant_id,'sha256:'||a.address_hash,
  CASE a.status WHEN 'active' THEN 'active' ELSE 'revoked' END,
  json_object('legacySource','agent_email_addresses','spaceId',a.space_id,'agentId',a.agent_id),a.created_at,a.created_at
FROM agent_email_addresses a JOIN spaces s ON s.id=a.space_id AND s.tenant_id=a.tenant_id
WHERE s.created_by IS NOT NULL
UNION ALL
SELECT 'acct-email-project-alias:'||a.address_hash,a.tenant_id,'svc-email-routing:'||a.tenant_id,'agentport_parent','individual',
  'prn-user:'||a.tenant_id||':'||s.created_by,'acct-email-domain:'||a.tenant_id,'sha256:'||a.address_hash,
  CASE a.status WHEN 'active' THEN 'active' ELSE 'revoked' END,
  json_object('legacySource','project_agent_email_addresses','spaceId',a.space_id,'agentId',a.agent_id,'projectId',a.project_id),a.created_at,a.created_at
FROM project_agent_email_addresses a JOIN spaces s ON s.id=a.space_id AND s.tenant_id=a.tenant_id
WHERE s.created_by IS NOT NULL;

INSERT OR IGNORE INTO agentport_account_grants
  (id,tenant_id,account_id,agent_id,granted_by,permissions_json,status,created_at,updated_at)
SELECT 'grt-email-alias:'||a.address_hash,a.tenant_id,'acct-email-alias:'||a.address_hash,
  'naelao:'||a.tenant_id||':'||a.space_id||':'||a.agent_id,s.created_by,'["email.receive"]',
  CASE a.status WHEN 'active' THEN 'active' ELSE 'revoked' END,a.created_at,a.created_at
FROM agent_email_addresses a JOIN spaces s ON s.id=a.space_id AND s.tenant_id=a.tenant_id
WHERE s.created_by IS NOT NULL
UNION ALL
SELECT 'grt-email-project-alias:'||a.address_hash,a.tenant_id,'acct-email-project-alias:'||a.address_hash,
  'naelao:'||a.tenant_id||':'||a.space_id||':'||a.agent_id,s.created_by,'["email.receive"]',
  CASE a.status WHEN 'active' THEN 'active' ELSE 'revoked' END,a.created_at,a.created_at
FROM project_agent_email_addresses a JOIN spaces s ON s.id=a.space_id AND s.tenant_id=a.tenant_id
WHERE s.created_by IS NOT NULL;
