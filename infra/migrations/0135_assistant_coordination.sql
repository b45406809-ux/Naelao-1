CREATE TABLE assistant_delivery_preferences (
 identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL, policy_json TEXT NOT NULL, PRIMARY KEY(identity_id,user_id)
);
CREATE TABLE assistant_delivery_receipts (
 identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL, event_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('sending','delivered','held','deferred')),
 channel TEXT, message_key TEXT, created_at INTEGER NOT NULL, attempted_at INTEGER, last_checked_at INTEGER, PRIMARY KEY(identity_id,user_id,event_id)
);
CREATE TABLE assistant_channel_conversations (
 identity_id TEXT NOT NULL REFERENCES assistant_communication_identities(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(identity_id,user_id)
);
CREATE TABLE assistant_approval_decisions (
 token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, space_id TEXT NOT NULL,
 approval_id TEXT NOT NULL, request_hash TEXT NOT NULL, user_id TEXT NOT NULL,
 channel TEXT NOT NULL, contact TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
 status TEXT NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','applying','applied','held')),
 expires_at INTEGER NOT NULL
);
CREATE INDEX assistant_approval_decisions_expiry ON assistant_approval_decisions(expires_at);
CREATE TABLE assistant_active_voice_endpoints (
 tenant_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 project_key TEXT NOT NULL, user_id TEXT NOT NULL, agent_name TEXT NOT NULL,
 connection_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,space_id,project_key,user_id)
);
-- Each authorized Project member may arm a private call without revoking another member's code.
DROP INDEX assistant_live_calls_armed;
CREATE UNIQUE INDEX assistant_live_calls_armed ON assistant_live_calls(binding_id,user_id) WHERE status='armed';
CREATE UNIQUE INDEX assistant_live_calls_code ON assistant_live_calls(binding_id,code_hash) WHERE status='armed';
-- An internal assistant line and an external extension line cannot share a carrier number.
ALTER TABLE assistant_phone_bindings ADD COLUMN purpose TEXT NOT NULL DEFAULT 'assistant' CHECK(purpose IN ('assistant','extension'));
UPDATE assistant_phone_bindings SET purpose='extension' WHERE id IN (SELECT binding_id FROM assistant_phone_extension_handlers WHERE status='active');
DROP INDEX assistant_phone_active_slot;
CREATE UNIQUE INDEX assistant_phone_active_slot ON assistant_phone_bindings(identity_id) WHERE purpose='assistant' AND status NOT IN ('released','detached');

CREATE INDEX assistant_delivery_retention ON assistant_delivery_receipts(created_at) WHERE message_key IS NOT NULL;
CREATE INDEX assistant_delivery_deferred ON assistant_delivery_receipts(status,created_at);
CREATE INDEX assistant_voice_endpoint_expiry ON assistant_active_voice_endpoints(expires_at);
