-- Naelao Spaces are generic workspaces. Preserve verified custom-hostname mappings under a
-- generic Space-domain record, then remove the retired storefront, reseller, and stored-value
-- accounting tables. FDE marketplace settlement uses separate marketplace/developer tables.
CREATE TABLE IF NOT EXISTS space_domains (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  provider_hostname_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('provisioning','active','pending_dns','suspended','deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_space_domains_space ON space_domains(tenant_id, space_id, status);

INSERT OR IGNORE INTO space_domains
  (id, space_id, tenant_id, domain, provider_hostname_id, config_json, status, created_at, updated_at)
SELECT id, space_id, tenant_id, custom_domain, cf_hostname_id, config_json, status, created_at, updated_at
FROM business_services
WHERE kind = 'custom_domain' AND custom_domain IS NOT NULL;

-- Membership is a generic Space capability. Keep existing users and their roles, but move the
-- child-Space index into the same canonical membership table used by the rest of the shell.
INSERT OR IGNORE INTO space_members
  (id, space_id, tenant_id, end_user_id, email, display_name, role, created_at, suspended_at)
SELECT lower(hex(randomblob(16))), bm.business_space_id, s.tenant_id, bm.end_user_id,
       u.email, u.display_name, bm.role, bm.joined_at,
       CASE WHEN bm.status = 'suspended' THEN datetime('now') ELSE NULL END
FROM business_memberships bm
JOIN spaces s ON s.id = bm.business_space_id
LEFT JOIN product_end_users u
  ON u.product_space_id = bm.product_space_id AND u.end_user_id = bm.end_user_id;

DROP TABLE IF EXISTS business_services;
DROP TABLE IF EXISTS business_memberships;
DROP TABLE IF EXISTS business_invites;
DROP TABLE IF EXISTS launchpad_products;
DROP TABLE IF EXISTS launchpad_orders;
DROP TABLE IF EXISTS business_subscriptions;
DROP TABLE IF EXISTS reseller_ledger;
DROP TABLE IF EXISTS reseller_accounts;
DROP TABLE IF EXISTS tenant_hierarchy;
DROP TABLE IF EXISTS payment_connections;
DROP TABLE IF EXISTS payout_destinations;
DROP TABLE IF EXISTS wallet_transactions;
DROP TABLE IF EXISTS whop_payout_requests;
DROP TABLE IF EXISTS whop_sub_merchants;
DROP TABLE IF EXISTS payout_requests;
