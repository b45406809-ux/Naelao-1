-- Preserve product IDs while separating product identity from end-user Space identity.
-- Legacy runtime paths still need a backing row in spaces. These triggers keep the registry
-- synchronized until the remaining paths are migrated and that backing row can be retired.
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  spacetype_id TEXT NOT NULL,
  name TEXT NOT NULL,
  product_slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO products (id, tenant_id, spacetype_id, name, product_slug, status, config_json, created_at, updated_at)
SELECT id, tenant_id, spacetype_id, name, product_slug, status, COALESCE(config_json, '{}'), created_at, updated_at
FROM spaces WHERE product_slug IS NOT NULL AND parent_space_id IS NULL;

-- End-user Spaces have a direct Product reference. Keep the old parent link during the
-- transition for services that have not yet moved to this column.
ALTER TABLE spaces ADD COLUMN product_id TEXT;
UPDATE spaces SET product_id = parent_space_id
WHERE parent_space_id IN (SELECT id FROM products);
CREATE INDEX IF NOT EXISTS idx_spaces_product_id ON spaces(product_id, status);

CREATE TRIGGER product_registry_space_insert AFTER INSERT ON spaces
WHEN NEW.product_slug IS NOT NULL AND NEW.parent_space_id IS NULL
BEGIN
  INSERT INTO products (id, tenant_id, spacetype_id, name, product_slug, status, config_json, created_at, updated_at)
  VALUES (NEW.id, NEW.tenant_id, NEW.spacetype_id, NEW.name, NEW.product_slug, NEW.status, COALESCE(NEW.config_json, '{}'), NEW.created_at, NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET tenant_id=excluded.tenant_id, spacetype_id=excluded.spacetype_id,
    name=excluded.name, product_slug=excluded.product_slug, status=excluded.status,
    config_json=excluded.config_json, updated_at=excluded.updated_at;
END;

CREATE TRIGGER product_registry_space_update AFTER UPDATE ON spaces
BEGIN
  DELETE FROM products WHERE id = OLD.id AND (NEW.product_slug IS NULL OR NEW.parent_space_id IS NOT NULL);
  INSERT INTO products (id, tenant_id, spacetype_id, name, product_slug, status, config_json, created_at, updated_at)
  SELECT NEW.id, NEW.tenant_id, NEW.spacetype_id, NEW.name, NEW.product_slug, NEW.status, COALESCE(NEW.config_json, '{}'), NEW.created_at, NEW.updated_at
  WHERE NEW.product_slug IS NOT NULL AND NEW.parent_space_id IS NULL
  ON CONFLICT(id) DO UPDATE SET tenant_id=excluded.tenant_id, spacetype_id=excluded.spacetype_id,
    name=excluded.name, product_slug=excluded.product_slug, status=excluded.status,
    config_json=excluded.config_json, updated_at=excluded.updated_at;
END;

CREATE TRIGGER product_registry_space_delete AFTER DELETE ON spaces
BEGIN
  DELETE FROM products WHERE id = OLD.id;
END;
