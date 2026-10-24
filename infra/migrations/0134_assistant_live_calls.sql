-- Human-authorized live voice sessions. Caller ID never supplies an acting identity.
CREATE TABLE assistant_live_calls (
 id TEXT PRIMARY KEY,
 binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id) ON DELETE CASCADE,
 tenant_id TEXT NOT NULL,
 space_id TEXT NOT NULL,
 project_id TEXT,
 user_id TEXT NOT NULL,
 caller_role TEXT NOT NULL,
 session_id TEXT NOT NULL,
 code_hash TEXT NOT NULL,
 call_sid TEXT,
 status TEXT NOT NULL CHECK(status IN ('armed','connected','ended','revoked')),
 expires_at INTEGER NOT NULL,
 deadline INTEGER,
 created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX assistant_live_calls_armed ON assistant_live_calls(binding_id) WHERE status='armed';
CREATE UNIQUE INDEX assistant_live_calls_call ON assistant_live_calls(call_sid) WHERE call_sid IS NOT NULL;
CREATE TABLE assistant_live_call_attempts (
 call_sid TEXT PRIMARY KEY,
 binding_id TEXT NOT NULL REFERENCES assistant_phone_bindings(id) ON DELETE CASCADE,
 attempts INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);
