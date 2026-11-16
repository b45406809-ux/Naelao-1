-- Durable, content-free crawl discovery. Source text is never stored or indexed by this path;
-- owners select a returned URL and use the existing single-page preview/review flow.
CREATE TABLE IF NOT EXISTS kb_website_crawl_operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  connection_ref TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  root_url TEXT NOT NULL CHECK (length(root_url) BETWEEN 1 AND 2048),
  connection_policy_sha256 TEXT NOT NULL CHECK (length(connection_policy_sha256)=64 AND connection_policy_sha256 NOT GLOB '*[^a-f0-9]*'),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash)=64 AND idempotency_key_hash NOT GLOB '*[^a-f0-9]*'),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  max_pages INTEGER NOT NULL CHECK (max_pages BETWEEN 1 AND 8),
  max_depth INTEGER NOT NULL CHECK (max_depth BETWEEN 0 AND 2),
  owner_terms_confirmed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'partial' CHECK (status IN ('running','partial','completed','paused')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 96),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (tenant_id,space_id,project_id,connection_ref,owner_user_id,idempotency_key_hash),
  CHECK ((status='running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status!='running')
);

CREATE INDEX IF NOT EXISTS idx_kb_website_crawl_expiry
  ON kb_website_crawl_operations(tenant_id,expires_at,id);

CREATE TABLE IF NOT EXISTS kb_website_crawl_pages (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES kb_website_crawl_operations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  requested_url TEXT NOT NULL CHECK (length(requested_url) BETWEEN 1 AND 2048),
  final_url TEXT CHECK (final_url IS NULL OR length(final_url) BETWEEN 1 AND 2048),
  parent_page_id TEXT REFERENCES kb_website_crawl_pages(id) ON DELETE CASCADE,
  depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 2),
  status TEXT NOT NULL CHECK (status IN ('queued','fetching','preview_ready','blocked','failed')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 3),
  content_sha256 TEXT CHECK (content_sha256 IS NULL OR (length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^a-f0-9]*')),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK (byte_count BETWEEN 0 AND 524288),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 96),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (operation_id,requested_url)
);

CREATE INDEX IF NOT EXISTS idx_kb_website_crawl_pages_queue
  ON kb_website_crawl_pages(operation_id,status,depth,created_at,id);

-- A revoked or changed host grant erases crawl URLs. A demoted/deleted Project owner does too.
CREATE TRIGGER IF NOT EXISTS kb_website_crawl_delete_on_connection_change
AFTER UPDATE OF status,origins_json,knowledge_path_prefixes_json,owner_user_id,project_id ON website_connections
WHEN NEW.status!='active' OR NEW.origins_json!=OLD.origins_json
  OR NEW.knowledge_path_prefixes_json!=OLD.knowledge_path_prefixes_json
  OR NEW.owner_user_id!=OLD.owner_user_id OR NEW.project_id IS NOT OLD.project_id
BEGIN
  DELETE FROM kb_website_crawl_operations WHERE connection_ref=NEW.id AND tenant_id=NEW.tenant_id
    AND space_id=NEW.space_id AND project_id=COALESCE(OLD.project_id,NEW.project_id);
END;

CREATE TRIGGER IF NOT EXISTS kb_website_crawl_delete_on_owner_demotion
AFTER UPDATE OF role_rank ON project_access
WHEN NEW.role_rank<40
BEGIN
  DELETE FROM kb_website_crawl_operations WHERE tenant_id=NEW.tenant_id AND space_id=NEW.space_id
    AND project_id=NEW.project_id AND owner_user_id=NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS kb_website_crawl_delete_on_owner_access_removal
AFTER DELETE ON project_access
BEGIN
  DELETE FROM kb_website_crawl_operations WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id
    AND project_id=OLD.project_id AND owner_user_id=OLD.user_id;
END;
