-- Durable, idempotent Modal operation intents. Provider calls remain disabled until a compatible
-- Node host, accepted SDK contract, verified capability and price policy are configured.
CREATE TABLE IF NOT EXISTS modal_sandbox_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  region TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  request_json TEXT NOT NULL CHECK(length(request_json)<=8192),
  record_json TEXT NOT NULL CHECK(length(record_json)<=8192),
  provider_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','reserved','creating','running','stopping','stopped','unknown','failed')),
  revision INTEGER NOT NULL CHECK(revision>=0),
  reserved_credits INTEGER NOT NULL CHECK(reserved_credits>0),
  actual_credits INTEGER CHECK(actual_credits IS NULL OR actual_credits>=0),
  overrun_credits INTEGER CHECK(overrun_credits IS NULL OR overrun_credits>=0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id,space_id,project_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_modal_sandbox_operations_recovery
  ON modal_sandbox_operations(state,updated_at);
CREATE INDEX IF NOT EXISTS idx_modal_sandbox_operations_scope
  ON modal_sandbox_operations(tenant_id,space_id,project_id,created_at);

CREATE TABLE IF NOT EXISTS modal_sandbox_operation_events (
  event_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  region TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','reserved','creating','running','stopping','stopped','unknown','failed')),
  revision INTEGER NOT NULL CHECK(revision>=0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(operation_id,revision)
);
CREATE INDEX IF NOT EXISTS idx_modal_sandbox_operation_events_scope
  ON modal_sandbox_operation_events(tenant_id,space_id,project_id,operation_id,created_at);

CREATE TRIGGER IF NOT EXISTS trg_modal_sandbox_operation_created_event
AFTER INSERT ON modal_sandbox_operations
BEGIN
  INSERT INTO modal_sandbox_operation_events(event_id,operation_id,tenant_id,space_id,project_id,actor_id,region,state,revision,error_code,created_at)
  VALUES('mse_' || lower(hex(randomblob(16))),NEW.operation_id,NEW.tenant_id,NEW.space_id,NEW.project_id,
    NEW.actor_id,NEW.region,NEW.state,NEW.revision,NULL,NEW.created_at);
END;
