-- Durable, scope-bound deletion intent for the non-atomic KB D1/Vectorize/R2/cache lifecycle.
CREATE TABLE IF NOT EXISTS kb_document_deletion_operations (
  document_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0 AND chunk_count <= 12000),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','complete')),
  vector_cursor INTEGER NOT NULL DEFAULT 0 CHECK (vector_cursor >= 0),
  r2_prefix_index INTEGER NOT NULL DEFAULT 0 CHECK (r2_prefix_index >= 0),
  r2_cursor TEXT,
  cache_generation_rotated_at TEXT,
  provider_mirror_status TEXT NOT NULL DEFAULT 'not_configured',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_kb_document_deletion_due
  ON kb_document_deletion_operations(state, next_attempt_at, lease_until, created_at);
CREATE INDEX IF NOT EXISTS idx_kb_document_deletion_scope
  ON kb_document_deletion_operations(tenant_id, space_id, state);

-- In-flight chunk/reindex batches hold a short document lease. Deletion first installs its
-- tombstone, then waits for any already-admitted writer before its final cross-store sweep.
CREATE TABLE IF NOT EXISTS kb_document_mutation_leases (
  document_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_document_mutation_lease_expiry
  ON kb_document_mutation_leases(lease_until);
