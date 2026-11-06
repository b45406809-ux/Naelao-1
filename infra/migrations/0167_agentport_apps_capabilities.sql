-- AgentPort apps are independent resource owners. A capability handle is a scoped
-- reference into an authorized provider account; it contains no provider credential.
CREATE TABLE IF NOT EXISTS agentport_apps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('individual','organization','agentport')),
  owner_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  agent_id TEXT REFERENCES agentport_agents(id),
  billing_mode TEXT NOT NULL CHECK (billing_mode IN ('managed','byok','customer')),
  monthly_budget_micros INTEGER NOT NULL CHECK (monthly_budget_micros >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agentport_apps_owner ON agentport_apps(tenant_id,owner_type,owner_id,status);

CREATE TABLE IF NOT EXISTS agentport_capability_handles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  account_id TEXT,
  authorization_mode TEXT NOT NULL CHECK (authorization_mode IN ('managed','byok','customer_oauth')),
  provisioning_phase TEXT NOT NULL CHECK (provisioning_phase IN ('build_time','runtime')),
  status TEXT NOT NULL CHECK (status IN ('active','authorization_required','provider_approval_required','adapter_unavailable','owner_approval_required','revoked')),
  readiness_status TEXT NOT NULL CHECK (readiness_status IN ('active','authorization_required','provider_approval_required','adapter_unavailable')),
  per_customer_limit INTEGER CHECK (per_customer_limit IS NULL OR per_customer_limit >= 0),
  monthly_budget_micros INTEGER CHECK (monthly_budget_micros IS NULL OR monthly_budget_micros >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (app_id) REFERENCES agentport_apps(id),
  FOREIGN KEY (service_id) REFERENCES agentport_services(id),
  FOREIGN KEY (account_id) REFERENCES agentport_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_capability_handles_app ON agentport_capability_handles(tenant_id,app_id,status);

-- Usage is an app-reported budget signal. Provider-confirmed settlement remains provider-owned
-- until a verified provider adapter is connected. Each report is idempotent per handle/key.
CREATE TABLE IF NOT EXISTS agentport_usage_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  capability_handle_id TEXT NOT NULL,
  customer_ref_hash TEXT,
  idempotency_key TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  reported_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (reported_cost_micros >= 0),
  period_month TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id,capability_handle_id,idempotency_key),
  FOREIGN KEY (app_id) REFERENCES agentport_apps(id),
  FOREIGN KEY (capability_handle_id) REFERENCES agentport_capability_handles(id)
);
CREATE INDEX IF NOT EXISTS idx_agentport_usage_app_period ON agentport_usage_records(tenant_id,app_id,period_month);
CREATE INDEX IF NOT EXISTS idx_agentport_usage_customer_period ON agentport_usage_records(tenant_id,capability_handle_id,customer_ref_hash,period_month);
