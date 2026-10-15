-- Provider-owned numbers are explicitly bound to one tenant/Space/customer agent.
CREATE TABLE IF NOT EXISTS customer_voice_space_policies (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL PRIMARY KEY,
  max_concurrent_calls INTEGER NOT NULL DEFAULT 5 CHECK (max_concurrent_calls BETWEEN 1 AND 50),
  max_calls_per_hour INTEGER NOT NULL DEFAULT 30 CHECK (max_calls_per_hour BETWEEN 1 AND 1000),
  max_daily_minutes INTEGER NOT NULL DEFAULT 120 CHECK (max_daily_minutes BETWEEN 1 AND 10000),
  monthly_spend_limit_minor INTEGER NOT NULL DEFAULT 5000 CHECK (monthly_spend_limit_minor BETWEEN 1 AND 100000000),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_voice_number_bindings (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'twilio'),
  provider_account_sid TEXT NOT NULL,
  provider_number_sid TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  country_code TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  provider_voice_url TEXT NOT NULL DEFAULT '',
  provider_voice_method TEXT NOT NULL DEFAULT 'POST',
  provider_status_callback TEXT NOT NULL DEFAULT '',
  provider_status_callback_method TEXT NOT NULL DEFAULT 'POST',
  provider_status_callback_events_json TEXT NOT NULL DEFAULT '[]',
  monthly_cost_minor INTEGER NOT NULL CHECK (monthly_cost_minor >= 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  monthly_quote_at TEXT NOT NULL,
  inbound_price_per_minute_minor INTEGER NOT NULL CHECK (inbound_price_per_minute_minor >= 0),
  max_concurrent_calls INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrent_calls BETWEEN 1 AND 20),
  max_call_duration_seconds INTEGER NOT NULL DEFAULT 300 CHECK (max_call_duration_seconds BETWEEN 30 AND 1800),
  assistant_prompt TEXT NOT NULL DEFAULT '' CHECK (length(assistant_prompt) <= 8000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'released')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_account_sid, provider_number_sid),
  UNIQUE (provider, provider_account_sid, phone_number)
);
CREATE INDEX IF NOT EXISTS idx_customer_voice_numbers_space
  ON customer_voice_number_bindings(tenant_id, space_id, status);

CREATE TABLE IF NOT EXISTS customer_voice_call_admissions (
  call_sid TEXT PRIMARY KEY,
  number_binding_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  caller_number TEXT NOT NULL,
  called_number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued', 'connected', 'completed', 'blocked', 'failed')),
  ticket_nonce TEXT NOT NULL UNIQUE,
  ticket_token TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  ticket_expires_at TEXT NOT NULL,
  consented_at TEXT,
  connected_at TEXT,
  ended_at TEXT,
  duration_seconds INTEGER,
  actual_cost_minor INTEGER,
  reserved_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cost_minor >= 0),
  reserved_duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (reserved_duration_seconds >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (number_binding_id) REFERENCES customer_voice_number_bindings(id)
);
CREATE INDEX IF NOT EXISTS idx_customer_voice_active_by_space
  ON customer_voice_call_admissions(tenant_id, space_id, status, ticket_expires_at);
CREATE INDEX IF NOT EXISTS idx_customer_voice_active_by_number
  ON customer_voice_call_admissions(number_binding_id, status, ticket_expires_at);
CREATE INDEX IF NOT EXISTS idx_customer_voice_calls_spend
  ON customer_voice_call_admissions(tenant_id, space_id, issued_at, status);
