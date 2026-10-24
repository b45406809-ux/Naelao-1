CREATE TABLE assistant_communication_identities (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 project_id TEXT, scope_key TEXT NOT NULL, owner_user_id TEXT NOT NULL,
 email_provider TEXT NOT NULL DEFAULT 'cloudflare', email_address TEXT, address_hash TEXT UNIQUE,
 email_status TEXT NOT NULL DEFAULT 'pending', status TEXT NOT NULL DEFAULT 'active',
 autonomy_json TEXT NOT NULL DEFAULT '{"mode":"approve","recipients":[],"dailySendLimit":20}',
 created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(tenant_id,space_id,scope_key)
);
CREATE TABLE assistant_communication_messages (
 id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE,
 provider_message_id TEXT, direction TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'email',
 sender TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', thread_id TEXT,
 status TEXT NOT NULL, body_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 approved_by TEXT, provider_result_id TEXT, error_code TEXT,
 UNIQUE(identity_id,provider_message_id)
);
CREATE INDEX assistant_messages_page ON assistant_communication_messages(identity_id,created_at,id);
CREATE TABLE assistant_communication_controllers (
 identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL, channel TEXT NOT NULL, address TEXT NOT NULL, verified_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active', PRIMARY KEY(identity_id,user_id,channel)
);
CREATE TABLE assistant_communication_commands (
 id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL UNIQUE REFERENCES assistant_communication_messages(id) ON DELETE CASCADE, controller_user_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', approved_at TEXT, run_id TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE assistant_verification_waits (
 id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE,
 tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT, actor_id TEXT NOT NULL,
 run_id TEXT NOT NULL, connection_id TEXT NOT NULL, kind TEXT NOT NULL,
 address_hash TEXT NOT NULL, sender_hosts_json TEXT NOT NULL, origins_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'waiting', secret_json TEXT, expires_at TEXT NOT NULL,
 message_id TEXT UNIQUE, consumed_action_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX assistant_verification_retention ON assistant_verification_waits(expires_at);
CREATE TABLE assistant_command_tokens (
 token_hash TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL, expires_at TEXT NOT NULL
);

CREATE TABLE assistant_website_mail_aliases (
 identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL, address_hash TEXT NOT NULL UNIQUE, email_address TEXT NOT NULL,
 PRIMARY KEY(identity_id,connection_id)
);
CREATE UNIQUE INDEX assistant_verification_active ON assistant_verification_waits(identity_id,connection_id) WHERE status IN ('waiting','received');
CREATE TABLE assistant_communication_aliases (
 address_hash TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE
);

CREATE INDEX assistant_message_retention ON assistant_communication_messages(created_at,id);
CREATE TABLE assistant_mail_ingress_usage (
 tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,day TEXT NOT NULL,bytes INTEGER NOT NULL,messages INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,space_id,day)
);
