-- Consent-backed mapping between a UserPort owner and an AgentPort principal.
CREATE TABLE IF NOT EXISTS managed_service_owner_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('user','organization')),
  owner_id TEXT NOT NULL,
  agentport_principal_id TEXT NOT NULL,
  linked_by_user_id TEXT NOT NULL,
  consent_source TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  revoked_by_user_id TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_service_owner_links_one_active
  ON managed_service_owner_links(tenant_id,owner_type,owner_id,agentport_principal_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_managed_service_owner_links_active
  ON managed_service_owner_links(tenant_id,owner_type,owner_id,status);
ALTER TABLE managed_service_accounts ADD COLUMN owner_link_id TEXT REFERENCES managed_service_owner_links(id);

-- A payer mandate records the owner consent that permits operations and optional renewals.
-- It does not create a balance; Billing remains the authoritative admission and charge ledger.
CREATE TABLE IF NOT EXISTS managed_service_payer_mandates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payer_type TEXT NOT NULL CHECK(payer_type IN ('user','organization','agent')),
  payer_id TEXT NOT NULL,
  mandate_key TEXT NOT NULL,
  authorized_by_user_id TEXT NOT NULL,
  operation_scopes_json TEXT NOT NULL,
  max_credits_per_operation INTEGER NOT NULL CHECK(max_credits_per_operation > 0),
  auto_renew INTEGER NOT NULL DEFAULT 0 CHECK(auto_renew IN (0,1)),
  expires_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','revoked','expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_by_user_id TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_service_payer_mandates_one_active
  ON managed_service_payer_mandates(tenant_id,payer_type,payer_id,mandate_key) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_managed_service_payer_mandates_scope
  ON managed_service_payer_mandates(tenant_id,payer_type,payer_id,status);
CREATE TABLE IF NOT EXISTS managed_service_payer_mandate_audit (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('authorized','revoked')),
  actor_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(mandate_id) REFERENCES managed_service_payer_mandates(id)
);
CREATE INDEX IF NOT EXISTS idx_managed_service_payer_mandate_audit
  ON managed_service_payer_mandate_audit(mandate_id,created_at);

-- Operator actions that verify or disable provider capability versions are auditable.
CREATE TABLE IF NOT EXISTS managed_service_capability_audit (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('verified','disabled')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  created_at TEXT NOT NULL,
  FOREIGN KEY(provider,service_id,version)
    REFERENCES managed_service_capability_versions(provider,service_id,version)
);
CREATE INDEX IF NOT EXISTS idx_managed_service_capability_audit_version
  ON managed_service_capability_audit(provider,service_id,version,created_at);
