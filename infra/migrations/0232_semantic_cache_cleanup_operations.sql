-- Extend the existing KB deletion journal so semantic-cache generation invalidation is followed
-- by bounded, resumable deletion of the exact Vectorize IDs and matching KV bodies.
ALTER TABLE kb_document_deletion_operations
  ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'document'
  CHECK (operation_kind IN ('document', 'space_cache'));
ALTER TABLE kb_document_deletion_operations ADD COLUMN erasure_request_id TEXT;
ALTER TABLE kb_document_deletion_operations ADD COLUMN cache_generation_to_purge TEXT;
ALTER TABLE kb_document_deletion_operations ADD COLUMN cache_generation_next TEXT;
ALTER TABLE kb_document_deletion_operations
  ADD COLUMN cache_cleanup_ids_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(cache_cleanup_ids_json));
ALTER TABLE kb_document_deletion_operations
  ADD COLUMN cache_cleanup_status TEXT NOT NULL DEFAULT 'not_started'
  CHECK (cache_cleanup_status IN ('not_started', 'pending', 'complete'));

-- Earlier code rotated the generation but did not retain the old generation or entry IDs. Reopen
-- those operations for a tenant/Space scoped rescan while preserving the immediate read barrier.
UPDATE kb_document_deletion_operations
   SET cache_generation_to_purge = '*',
       cache_cleanup_status = 'pending',
       state = 'pending',
       next_attempt_at = datetime('now'),
       lease_token = NULL,
       lease_until = NULL,
       updated_at = datetime('now')
 WHERE cache_generation_rotated_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kb_cache_cleanup_due
  ON kb_document_deletion_operations(operation_kind, cache_cleanup_status, state, next_attempt_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_space_cache_erasure_request
  ON kb_document_deletion_operations(erasure_request_id, space_id)
  WHERE operation_kind = 'space_cache' AND erasure_request_id IS NOT NULL;

-- Whole-organization erasure retains its aggregate cache cleanup result after Space rows are gone.
ALTER TABLE gdpr_requests
  ADD COLUMN cache_cleanup_status TEXT NOT NULL DEFAULT 'not_started'
  CHECK (cache_cleanup_status IN ('not_started', 'pending', 'complete'));

-- Preserve in-flight erasure work across the migration-before-Worker deployment window. The old
-- Worker may complete these synthetic rows as document deletions; pending cache status makes the
-- new reconciler reopen them and perform the physical cache purge after the new code is live.
INSERT OR IGNORE INTO kb_document_deletion_operations
  (document_id, tenant_id, space_id, project_id, chunk_count, state, next_attempt_at,
   created_at, updated_at, operation_kind, erasure_request_id, cache_generation_to_purge,
   cache_generation_next, cache_cleanup_status)
SELECT 'spacecache_backfill_' || g.id || '_' || s.id, g.tenant_id, s.id, NULL, 0,
       'pending', datetime('now'), datetime('now'), datetime('now'), 'space_cache', g.id,
       '*', 'cache-' || lower(hex(randomblob(16))), 'pending'
  FROM gdpr_requests g JOIN spaces s ON s.tenant_id = g.tenant_id
 WHERE g.request_type = 'erasure' AND g.status = 'processing';

UPDATE gdpr_requests SET cache_cleanup_status = 'pending', updated_at = datetime('now')
 WHERE request_type = 'erasure' AND status = 'processing'
   AND EXISTS (SELECT 1 FROM kb_document_deletion_operations o
     WHERE o.erasure_request_id = gdpr_requests.id AND o.operation_kind = 'space_cache');
