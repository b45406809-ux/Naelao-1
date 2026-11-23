-- Rotate Knowledge retrieval cache generations when canonical content, source lineage,
-- Space/member access, publication membership or project ACL changes. Existing entries predate
-- source_generation metadata and remain unreachable under the versioned cache key/filter.
CREATE TABLE IF NOT EXISTS kb_search_cache_freshness (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, space_id)
);

INSERT OR IGNORE INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
SELECT tenant_id, id, 1, datetime('now') FROM spaces;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_spaces_insert
AFTER INSERT ON spaces
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_spaces_update
AFTER UPDATE OF tenant_id, id, status ON spaces
WHEN OLD.tenant_id != NEW.tenant_id OR OLD.id != NEW.id OR OLD.status != NEW.status
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_spaces_old_scope_update
AFTER UPDATE OF tenant_id, id ON spaces
WHEN OLD.tenant_id != NEW.tenant_id OR OLD.id != NEW.id
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_spaces_delete
AFTER DELETE ON spaces
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_space_members_insert
AFTER INSERT ON space_members
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_space_members_update
AFTER UPDATE OF tenant_id, space_id, end_user_id, role, suspended_at ON space_members
WHEN OLD.tenant_id != NEW.tenant_id OR OLD.space_id != NEW.space_id OR OLD.end_user_id != NEW.end_user_id
  OR OLD.role != NEW.role OR OLD.suspended_at IS NOT NEW.suspended_at
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_space_members_old_scope_update
AFTER UPDATE OF tenant_id, space_id ON space_members
WHEN OLD.tenant_id != NEW.tenant_id OR OLD.space_id != NEW.space_id
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_space_members_delete
AFTER DELETE ON space_members
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_documents_insert
AFTER INSERT ON kb_documents
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_documents_update
AFTER UPDATE ON kb_documents
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_documents_old_scope_update
AFTER UPDATE OF tenant_id, space_id ON kb_documents
WHEN OLD.tenant_id != NEW.tenant_id OR OLD.space_id != NEW.space_id
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_documents_delete
AFTER DELETE ON kb_documents
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_chunks_insert
AFTER INSERT ON kb_chunks
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_chunks_update
AFTER UPDATE ON kb_chunks
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_chunks_old_scope_update
AFTER UPDATE OF tenant_id, space_id ON kb_chunks
WHEN OLD.tenant_id != NEW.tenant_id OR OLD.space_id != NEW.space_id
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_chunks_delete
AFTER DELETE ON kb_chunks
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_project_access_insert
AFTER INSERT ON project_access
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_project_access_update
AFTER UPDATE ON project_access
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_project_access_old_scope_update
AFTER UPDATE OF tenant_id, space_id ON project_access
WHEN OLD.tenant_id != NEW.tenant_id OR OLD.space_id != NEW.space_id
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_project_access_delete
AFTER DELETE ON project_access
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_publications_insert
AFTER INSERT ON kb_external_publications
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_publications_update
AFTER UPDATE ON kb_external_publications
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_publications_old_scope_update
AFTER UPDATE OF tenant_id, space_id ON kb_external_publications
WHEN OLD.tenant_id != NEW.tenant_id OR OLD.space_id != NEW.space_id
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_publications_delete
AFTER DELETE ON kb_external_publications
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_publication_membership_insert
AFTER INSERT ON kb_external_publication_documents
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_publication_membership_update
AFTER UPDATE ON kb_external_publication_documents
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_publication_membership_old_scope_update
AFTER UPDATE OF tenant_id, space_id ON kb_external_publication_documents
WHEN OLD.tenant_id != NEW.tenant_id OR OLD.space_id != NEW.space_id
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_publication_membership_delete
AFTER DELETE ON kb_external_publication_documents
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_website_connections_insert
AFTER INSERT ON website_connections
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_website_connections_update
AFTER UPDATE ON website_connections
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (NEW.tenant_id, NEW.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_website_connections_old_scope_update
AFTER UPDATE OF tenant_id, space_id ON website_connections
WHEN OLD.tenant_id != NEW.tenant_id OR OLD.space_id != NEW.space_id
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS kb_search_cache_freshness_website_connections_delete
AFTER DELETE ON website_connections
BEGIN
  INSERT INTO kb_search_cache_freshness (tenant_id, space_id, generation, updated_at)
  VALUES (OLD.tenant_id, OLD.space_id, 1, datetime('now'))
  ON CONFLICT(tenant_id, space_id) DO UPDATE SET generation=generation+1, updated_at=datetime('now');
END;
