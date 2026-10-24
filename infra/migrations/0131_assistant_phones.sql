-- Paid numbers must be detached/released before deleting their assistant identity.
CREATE TABLE assistant_phone_bindings (
 id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id),
 payer TEXT NOT NULL CHECK(payer IN ('byo','managed')), provider_account_sid TEXT NOT NULL,
 provider_number_sid TEXT, phone_number TEXT, country_code TEXT,
 capabilities_json TEXT NOT NULL DEFAULT '{}', previous_callbacks_json TEXT NOT NULL DEFAULT '{}',
 status TEXT NOT NULL DEFAULT 'configuring', policy_json TEXT NOT NULL,
 monthly_cost_minor INTEGER, currency TEXT NOT NULL DEFAULT 'USD',
 created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX assistant_phone_active_slot ON assistant_phone_bindings(identity_id) WHERE status NOT IN ('released','detached');
CREATE UNIQUE INDEX assistant_phone_active_number ON assistant_phone_bindings(provider_number_sid) WHERE status NOT IN ('released','detached');
CREATE UNIQUE INDEX assistant_phone_active_address ON assistant_phone_bindings(phone_number) WHERE status NOT IN ('released','detached');
CREATE TABLE assistant_phone_quotes (
 id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE,
 payer TEXT NOT NULL, provider_account_sid TEXT NOT NULL, phone_number TEXT NOT NULL,
 country_code TEXT NOT NULL, monthly_cost_minor INTEGER NOT NULL, inbound_rate_minor INTEGER NOT NULL,
 quoted_by TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'quoted', expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE assistant_phone_actions (
 id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id),
 actor_id TEXT NOT NULL, kind TEXT NOT NULL, recipient TEXT NOT NULL,
 body_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', approved_by TEXT,
 provider_sid TEXT UNIQUE, error_code TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX assistant_phone_actions_page ON assistant_phone_actions(binding_id,created_at,id);
CREATE TABLE assistant_phone_events (
 id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id),
 kind TEXT NOT NULL, sender TEXT NOT NULL, status TEXT NOT NULL,
 body_key TEXT, action_id TEXT REFERENCES assistant_phone_actions(id),
 duration_seconds INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX assistant_phone_events_page ON assistant_phone_events(binding_id,created_at,id);
CREATE TABLE assistant_phone_ingress_usage (
 binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id), day TEXT NOT NULL,
 messages INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(binding_id,day)
);
