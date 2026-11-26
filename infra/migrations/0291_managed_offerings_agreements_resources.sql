-- MS-27 (V-spec §6.1–6.3, MD-2, MD-3): P0 managed-service catalog and resource columns.
-- Additive only. No code reads these columns or tables yet; MS-28 adds the admin routes and the
-- fail-closed admission helper. Nothing here is applied to a remote database by the repository.

-- §6.2 Offerings: a purchasable configuration for one capability version.
-- capability_version is INTEGER to match managed_service_capability_versions.version and
-- managed_service_accounts.capability_version (the V-spec draft wrote TEXT).
CREATE TABLE IF NOT EXISTS managed_service_offerings (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  capability_version INTEGER NOT NULL CHECK(capability_version > 0),
  resource_type TEXT NOT NULL,
  category TEXT NOT NULL,
  display_name TEXT NOT NULL,
  access_modes_json TEXT NOT NULL,
  strategies_json TEXT NOT NULL,
  regions_json TEXT NOT NULL,
  configuration_schema_json TEXT NOT NULL,
  charge_components_json TEXT NOT NULL,
  quote_policy TEXT NOT NULL CHECK(quote_policy IN ('none','required_for_recurring','always')),
  data_handling_json TEXT NOT NULL,
  preference_rank INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL CHECK(status IN ('draft','testing','available','restricted','deprecated','disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(provider, service_id, capability_version)
    REFERENCES managed_service_capability_versions(provider, service_id, version)
);

-- Audit rows are never cascaded or deleted with their offering (V-spec MR-RES-6 principle).
CREATE TABLE IF NOT EXISTS managed_service_offering_audit (
  id TEXT PRIMARY KEY,
  offering_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_managed_service_offering_audit_offering
  ON managed_service_offering_audit(offering_id, created_at);

-- §6.3 Commercial agreements: what Naelao may legally resell. first_party agreements are seeded
-- later with verification_status 'unverified' so a first-party offering cannot go live by accident.
CREATE TABLE IF NOT EXISTS managed_service_commercial_agreements (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  agreement_type TEXT NOT NULL CHECK(agreement_type IN ('standard_terms','reseller','wholesale','platform_partner','referral','first_party')),
  permitted_offering_ids_json TEXT NOT NULL,
  permits_managed_provisioning INTEGER NOT NULL CHECK(permits_managed_provisioning IN (0,1)),
  permits_master_account_distribution INTEGER NOT NULL CHECK(permits_master_account_distribution IN (0,1)),
  permits_subaccount_distribution INTEGER NOT NULL CHECK(permits_subaccount_distribution IN (0,1)),
  permits_shared_resources INTEGER NOT NULL CHECK(permits_shared_resources IN (0,1)),
  permitted_regions_json TEXT NOT NULL,
  minimum_commitment_credits INTEGER,
  effective_from INTEGER NOT NULL,
  expires_at INTEGER,
  verification_status TEXT NOT NULL CHECK(verification_status IN ('unverified','under_review','approved','expired','revoked')),
  evidence_sha256 TEXT CHECK(evidence_sha256 IS NULL OR length(evidence_sha256) = 64),
  approved_by TEXT,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_managed_service_commercial_agreements_provider
  ON managed_service_commercial_agreements(provider, verification_status);

CREATE TABLE IF NOT EXISTS managed_service_commercial_agreement_audit (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_managed_service_commercial_agreement_audit_agreement
  ON managed_service_commercial_agreement_audit(agreement_id, created_at);

-- §6.1 Resource columns on the canonical registry (MD-2). Every column is nullable or has a
-- default, so existing rows stay valid. offering_id stays NULL for legacy rows.
ALTER TABLE managed_service_accounts ADD COLUMN category TEXT
  CHECK(category IS NULL OR category IN ('email','phone','messaging','model','browser','compute','storage','search'));
ALTER TABLE managed_service_accounts ADD COLUMN resource_type TEXT;
ALTER TABLE managed_service_accounts ADD COLUMN offering_id TEXT REFERENCES managed_service_offerings(id);
ALTER TABLE managed_service_accounts ADD COLUMN access_mode TEXT
  CHECK(access_mode IS NULL OR access_mode IN ('managed','byok'));
ALTER TABLE managed_service_accounts ADD COLUMN provisioning_strategy TEXT
  CHECK(provisioning_strategy IS NULL OR provisioning_strategy IN ('first_party','managed_master','native_subaccount','customer_connection','partner_direct'));
ALTER TABLE managed_service_accounts ADD COLUMN sharing_class TEXT NOT NULL DEFAULT 'dedicated'
  CHECK(sharing_class IN ('dedicated','organization_shared'));
ALTER TABLE managed_service_accounts ADD COLUMN display_name TEXT;
ALTER TABLE managed_service_accounts ADD COLUMN subscription_id TEXT;
ALTER TABLE managed_service_accounts ADD COLUMN ownership_json TEXT;
ALTER TABLE managed_service_accounts ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version >= 1);

-- MR-RES-1 backfill from connection_mode. Only rows whose access_mode is still unset are touched,
-- so re-running the backfill by hand cannot change a row that code has already classified.
UPDATE managed_service_accounts
   SET access_mode = CASE connection_mode
         WHEN 'naelao_managed' THEN 'managed'
         WHEN 'user_connected' THEN 'byok'
         WHEN 'provider_managed' THEN 'managed'
       END,
       provisioning_strategy = CASE connection_mode
         WHEN 'naelao_managed' THEN 'managed_master'
         WHEN 'user_connected' THEN 'customer_connection'
         WHEN 'provider_managed' THEN 'native_subaccount'
       END
 WHERE access_mode IS NULL AND provisioning_strategy IS NULL;

-- MR-RES-4 uniqueness, scoped to offering-backed rows. Legacy rows are excluded on purpose:
-- Higgsfield customer-owned accounts all store the placeholder ref 'customer-owned-api-key', and
-- other legacy refs (AgentMail inbox ids, Telnyx number SIDs) were never checked for uniqueness,
-- so a full unique index would fail on existing data. Only rows that name an offering are
-- checked. No code path creates offering_id rows yet, so the index is inert until MS-28 and later.
CREATE UNIQUE INDEX IF NOT EXISTS ux_msa_provider_ref
  ON managed_service_accounts(provider, provider_resource_ref)
  WHERE provider_resource_ref IS NOT NULL AND offering_id IS NOT NULL;

-- V-spec field names over the canonical table (MD-2). The view adds no storage and no rules.
CREATE VIEW IF NOT EXISTS managed_resources AS
SELECT id, tenant_id, space_id, project_id, provider, service_id, capability_version,
       category, resource_type, offering_id, connection_mode, access_mode, provisioning_strategy,
       sharing_class, display_name, provider_resource_ref, subscription_id, owner_type, owner_id,
       ownership_json, region, lifecycle_state, row_version, created_at, updated_at
  FROM managed_service_accounts;
