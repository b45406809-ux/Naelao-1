-- Portal hostname ownership needs atomic uniqueness; KV cannot safely arbitrate concurrent claims.
CREATE TABLE IF NOT EXISTS portal_domains (
  kind TEXT NOT NULL CHECK (kind IN ('domain', 'subdomain')),
  hostname TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, hostname)
);

CREATE INDEX IF NOT EXISTS idx_portal_domains_tenant_kind_hostname
  ON portal_domains (tenant_id, kind, hostname);
