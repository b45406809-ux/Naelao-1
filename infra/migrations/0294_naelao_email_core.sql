-- MS-31: Naelao Email (first-party provider, V-spec §12.2). Not applied remotely.
-- Every row carries nemail_tenant_id; the tenant is resolved only from an API key.
CREATE TABLE IF NOT EXISTS nemail_tenants (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs(id),
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  daily_send_limit_override INTEGER,
  sending_paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nemail_tenants_org ON nemail_tenants(org_id) WHERE org_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS nemail_api_keys (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  key_hash TEXT NOT NULL UNIQUE,        -- SHA-256 hex of the full key; the key itself is never stored
  key_prefix TEXT NOT NULL,             -- first 8 characters, display only
  scopes_json TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_nemail_api_keys_tenant ON nemail_api_keys(nemail_tenant_id);

CREATE TABLE IF NOT EXISTS nemail_domains (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  domain TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nemail_inboxes (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  domain TEXT NOT NULL,
  local_part TEXT NOT NULL,
  address TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  sending_paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nemail_inboxes_address ON nemail_inboxes(address) WHERE status != 'deleted';
CREATE INDEX IF NOT EXISTS idx_nemail_inboxes_tenant ON nemail_inboxes(nemail_tenant_id, status, created_at);

CREATE TABLE IF NOT EXISTS nemail_addresses (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  inbox_id TEXT NOT NULL REFERENCES nemail_inboxes(id),
  address TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nemail_addresses_address ON nemail_addresses(address) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS nemail_threads (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  inbox_id TEXT NOT NULL REFERENCES nemail_inboxes(id),
  subject TEXT NOT NULL DEFAULT '',
  last_message_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nemail_threads_inbox ON nemail_threads(nemail_tenant_id, inbox_id, last_message_at);

CREATE TABLE IF NOT EXISTS nemail_messages (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  inbox_id TEXT NOT NULL REFERENCES nemail_inboxes(id),
  thread_id TEXT REFERENCES nemail_threads(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  message_id_header TEXT,
  in_reply_to TEXT,
  references_json TEXT,
  from_address TEXT,
  to_json TEXT,
  subject TEXT,
  raw_r2_key TEXT,
  raw_sha256 TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'stored' CHECK (state IN ('stored','parsed','parse_error','rejected')),
  error_code TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nemail_messages_inbox ON nemail_messages(nemail_tenant_id, inbox_id, received_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nemail_messages_dedup ON nemail_messages(inbox_id, message_id_header) WHERE message_id_header IS NOT NULL AND direction = 'inbound';

CREATE TABLE IF NOT EXISTS nemail_attachments (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  message_id TEXT NOT NULL REFERENCES nemail_messages(id),
  filename TEXT,
  content_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nemail_drafts (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  inbox_id TEXT NOT NULL REFERENCES nemail_inboxes(id),
  in_reply_to_message_id TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT,
  html_body TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','discarded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nemail_deliveries (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  inbox_id TEXT NOT NULL REFERENCES nemail_inboxes(id),
  message_id TEXT REFERENCES nemail_messages(id),
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','bounced','complained','failed','unknown')),
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nemail_deliveries_tenant ON nemail_deliveries(nemail_tenant_id, created_at);

CREATE TABLE IF NOT EXISTS nemail_webhooks (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  url TEXT NOT NULL,
  event_types_json TEXT NOT NULL,
  secret_ciphertext TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS nemail_suppressions (
  id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  address TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('hard_bounce','complaint','manual')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (nemail_tenant_id, address)
);

-- Idempotency-Key replay store for POST/DELETE (tenant-scoped, not shared with idempotency_keys).
CREATE TABLE IF NOT EXISTS nemail_idempotency (
  nemail_tenant_id TEXT NOT NULL REFERENCES nemail_tenants(id),
  idem_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed')),
  response_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (nemail_tenant_id, idem_key, operation)
);
