-- Release models for build-plan items 45-87. All globally indexed records carry tenant and
-- space scope; actor-owned records additionally carry project/invoker/actor scope.
CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT NOT NULL,
  document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL,
  content_hash TEXT NOT NULL, visibility TEXT NOT NULL CHECK (visibility IN ('space','project')),
  required_role_rank INTEGER NOT NULL, source_freshness TEXT NOT NULL, heading_path TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL,
  line_start INTEGER NOT NULL, line_end INTEGER NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT,
  UNIQUE (tenant_id, space_id, project_id, document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_sparse_scope
  ON kb_chunks(tenant_id, space_id, project_id, required_role_rank, deleted_at);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
  content, content='kb_chunks', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE OF content ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO kb_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE IF NOT EXISTS project_access (
  tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
  role_rank INTEGER NOT NULL, visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
  PRIMARY KEY (tenant_id, space_id, project_id, user_id)
);

CREATE TABLE IF NOT EXISTS platform_provenance (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL, project_id TEXT NOT NULL, invoker_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL, canonical_payload TEXT NOT NULL, previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE, checkpoint_signature TEXT, signing_key_id TEXT, created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS platform_provenance_no_update BEFORE UPDATE ON platform_provenance
BEGIN SELECT RAISE(ABORT, 'provenance is append-only'); END;
CREATE TRIGGER IF NOT EXISTS platform_provenance_no_delete BEFORE DELETE ON platform_provenance
BEGIN SELECT RAISE(ABORT, 'provenance is append-only'); END;

CREATE TABLE IF NOT EXISTS space_compliance_policy (
  tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, version INTEGER NOT NULL, vertical TEXT NOT NULL,
  whitelist_only INTEGER NOT NULL CHECK (whitelist_only IN (0,1)), certified_model_ids TEXT NOT NULL,
  air_gapped INTEGER NOT NULL CHECK (air_gapped IN (0,1)), allowed_local_endpoints TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, space_id, version)
);

CREATE TABLE IF NOT EXISTS installed_extensions (
  tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT NOT NULL, instance_id TEXT NOT NULL,
  extension_id TEXT NOT NULL, manifest_version TEXT NOT NULL, manifest_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL, enabled INTEGER NOT NULL, installed_by TEXT NOT NULL, installed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, space_id, project_id, instance_id)
);

CREATE TABLE IF NOT EXISTS workflow_executions_v2 (
  tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT NOT NULL, execution_id TEXT PRIMARY KEY,
  workflow_class TEXT NOT NULL CHECK (workflow_class IN ('company_automation','vertical_extension','ephemeral_task')),
  owner_id TEXT NOT NULL, invoker_id TEXT NOT NULL, actor_id TEXT NOT NULL, extension_instance_id TEXT,
  state TEXT NOT NULL, attempt INTEGER NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, UNIQUE (tenant_id, space_id, project_id, idempotency_key)
);
