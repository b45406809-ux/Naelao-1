-- Product identity is independent of workspace rows from this migration onward.
DROP TRIGGER IF EXISTS product_registry_space_insert;
DROP TRIGGER IF EXISTS product_registry_space_update;
DROP TRIGGER IF EXISTS product_registry_space_delete;

-- Record contradictory historical links for operator review. Keep the source values intact;
-- they are never silently rewritten to another Product.
CREATE TABLE IF NOT EXISTS product_link_migration_issues (
  space_id TEXT PRIMARY KEY,
  recorded_parent_space_id TEXT,
  recorded_product_id TEXT,
  reason TEXT NOT NULL,
  recorded_product_slug TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO product_link_migration_issues(space_id, recorded_parent_space_id, recorded_product_id, reason, recorded_product_slug)
SELECT s.id, s.parent_space_id, s.product_id,
       CASE WHEN parent_space.id IS NULL THEN 'parent_space_missing'
            WHEN p.id IS NOT NULL AND p.tenant_id != s.tenant_id THEN 'parent_product_tenant_mismatch'
            WHEN p.id IS NOT NULL AND s.product_id IS NOT NULL AND s.product_id != p.id THEN 'direct_product_conflict'
       END, s.product_slug
FROM spaces s LEFT JOIN spaces parent_space ON parent_space.id = s.parent_space_id
LEFT JOIN products p ON p.id = s.parent_space_id
WHERE s.parent_space_id IS NOT NULL AND
      (parent_space.id IS NULL OR (p.id IS NOT NULL AND (p.tenant_id != s.tenant_id OR (s.product_id IS NOT NULL AND s.product_id != p.id))));

INSERT OR IGNORE INTO product_link_migration_issues(space_id, recorded_parent_space_id, recorded_product_id, reason, recorded_product_slug)
SELECT s.id, s.parent_space_id, s.product_id, 'legacy_product_row_not_registered', s.product_slug
FROM spaces s LEFT JOIN products p ON p.id = s.id
WHERE s.product_slug IS NOT NULL AND p.id IS NULL;

-- Only unambiguous same-tenant legacy Product parents are migrated. Preserve conflicting rows
-- verbatim in the issue table and leave them available for explicit repair.
UPDATE spaces
SET product_id = parent_space_id, parent_space_id = NULL, depth = 0
WHERE (product_id IS NULL OR product_id = parent_space_id)
  AND product_slug IS NULL
  AND parent_space_id IN (SELECT id FROM products WHERE products.tenant_id = spaces.tenant_id);

-- Never provision the compatibility row as a Space after the Product cutover. Keep its row and
-- data intact, but cancel any unsent provisioning intents; the provisioner also rejects stale
-- messages that were already delivered before this migration.
UPDATE space_provisioning_outbox SET status='cancelled', last_error='product_registry_cutover', updated_at=datetime('now')
WHERE space_id IN (SELECT id FROM products) AND status='pending';

-- Customer plans belong to the Launchpad account, never to the team's shared organization.
CREATE TABLE IF NOT EXISTS product_user_subscriptions (
  product_id TEXT NOT NULL,
  end_user_id TEXT NOT NULL,
  plan_tier TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  provider TEXT,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  current_period_end TEXT,
  provider_event_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (product_id, end_user_id),
  UNIQUE(provider, provider_subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_product_user_subscriptions_provider_customer
  ON product_user_subscriptions(provider, provider_customer_id);

ALTER TABLE products ADD COLUMN suspension_reason TEXT;
INSERT OR IGNORE INTO product_link_migration_issues(space_id, recorded_parent_space_id, recorded_product_id, reason, recorded_product_slug)
SELECT s.id, s.parent_space_id, s.product_id,
       CASE WHEN p.id IS NULL THEN 'direct_product_missing' ELSE 'direct_product_tenant_mismatch' END, s.product_slug
FROM spaces s LEFT JOIN products p ON p.id = s.product_id
WHERE s.product_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id != s.tenant_id);

-- 0156 populated product_id from parent_space_id without checking tenant ownership or whether
-- the row itself was another legacy Product. Undo only those generated links; the original parent
-- value and audit record remain for explicit operator resolution.
UPDATE spaces SET product_id = NULL
WHERE product_id = parent_space_id
  AND (product_slug IS NOT NULL OR parent_space_id IN (SELECT id FROM products WHERE products.tenant_id != spaces.tenant_id));
