export interface KnowledgeDeletionBindings {
  PLATFORM_DB: D1Database;
  KB_BUCKET: R2Bucket;
  KB_VECTORS: VectorizeIndex;
  SEMANTIC_CACHE_KV: KVNamespace;
  AUTORAG_KB_INSTANCE?: string;
}

export interface KnowledgeDocumentDeletion {
  document_id: string;
  tenant_id: string;
  space_id: string;
  project_id: string | null;
  chunk_count: number;
  state: "pending" | "complete";
  vector_cursor: number;
  r2_prefix_index: number;
  r2_cursor: string | null;
  cache_generation_rotated_at: string | null;
  provider_mirror_status: string;
  attempts: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const VECTOR_BATCH_SIZE = 100;
const VECTOR_BATCHES_PER_RUN = 10;
const R2_PAGE_SIZE = 1000;
const R2_PAGES_PER_RUN = 4;
const DELETION_LEASE_MS = 10 * 60_000;

function deletionPrefixes(operation: KnowledgeDocumentDeletion): string[] {
  const project = operation.project_id ?? "_space";
  return [
    `kb/${operation.space_id}/${project}/${operation.document_id}/`,
    ...(operation.project_id
      ? [
          `staging/${operation.tenant_id}/${operation.space_id}/${operation.project_id}/${operation.document_id}/`,
        ]
      : []),
  ];
}

function autoragKey(operation: KnowledgeDocumentDeletion): string {
  return `autorag/${operation.space_id}/${operation.project_id ?? "_space"}/${operation.document_id}.md`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function retryAt(attempt: number, now = Date.now()): string {
  const delaySeconds = Math.min(
    3600,
    5 * 2 ** Math.min(Math.max(attempt - 1, 0), 10)
  );
  return new Date(now + delaySeconds * 1000).toISOString();
}

export async function acquireKnowledgeDocumentMutationLease(
  db: D1Database,
  scope: { documentId: string; tenantId: string; spaceId: string }
): Promise<string | null> {
  const token = crypto.randomUUID();
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + DELETION_LEASE_MS).toISOString();
  const result = await db
    .prepare(`INSERT INTO kb_document_mutation_leases
      (document_id,tenant_id,space_id,lease_token,lease_until,created_at)
    SELECT ?,?,?,?,?,?
    WHERE EXISTS (SELECT 1 FROM kb_documents WHERE id=? AND tenant_id=? AND space_id=? AND status!='deleting')
      AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)
    ON CONFLICT(document_id) DO UPDATE SET tenant_id=excluded.tenant_id,space_id=excluded.space_id,
      lease_token=excluded.lease_token,lease_until=excluded.lease_until,created_at=excluded.created_at
    WHERE kb_document_mutation_leases.lease_until<=?
      AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`)
    .bind(
      scope.documentId,
      scope.tenantId,
      scope.spaceId,
      token,
      leaseUntil,
      now,
      scope.documentId,
      scope.tenantId,
      scope.spaceId,
      scope.documentId,
      now,
      scope.documentId
    )
    .run();
  return result.meta.changes ? token : null;
}

export async function releaseKnowledgeDocumentMutationLease(
  db: D1Database,
  documentId: string,
  token: string
): Promise<void> {
  await db
    .prepare(
      "DELETE FROM kb_document_mutation_leases WHERE document_id=? AND lease_token=?"
    )
    .bind(documentId, token)
    .run();
}

export async function renewKnowledgeDocumentMutationLease(
  db: D1Database,
  documentId: string,
  token: string
): Promise<boolean> {
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + DELETION_LEASE_MS).toISOString();
  const result = await db
    .prepare(`UPDATE kb_document_mutation_leases SET lease_until=?
    WHERE document_id=? AND lease_token=? AND lease_until>? AND NOT EXISTS (
      SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`)
    .bind(leaseUntil, documentId, token, now, documentId)
    .run();
  return result.meta.changes > 0;
}

export async function hasPendingKnowledgeDocumentDeletion(
  db: D1Database,
  tenantId: string,
  spaceId: string
): Promise<boolean> {
  try {
    return Boolean(
      await db
        .prepare(`SELECT document_id FROM kb_document_deletion_operations
      WHERE tenant_id=? AND space_id=? AND state='pending' LIMIT 1`)
        .bind(tenantId, spaceId)
        .first()
    );
  } catch {
    // A cache hit must never bypass a missing or unavailable deletion ledger.
    return true;
  }
}

export async function hasKnowledgeDocumentDeletionSince(
  db: D1Database,
  tenantId: string,
  spaceId: string,
  since: string
): Promise<boolean> {
  try {
    return Boolean(
      await db
        .prepare(`SELECT document_id FROM kb_document_deletion_operations
      WHERE tenant_id=? AND space_id=? AND created_at>=? LIMIT 1`)
        .bind(tenantId, spaceId, since)
        .first()
    );
  } catch {
    // Suppress a response assembled across a deletion if the durable fence cannot be read.
    return true;
  }
}

async function rotateSemanticCacheGeneration(
  operation: KnowledgeDocumentDeletion,
  env: KnowledgeDeletionBindings,
  token: string
): Promise<KnowledgeDocumentDeletion> {
  if (operation.cache_generation_rotated_at) return operation;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${operation.tenant_id}:${operation.space_id}`)
  );
  const key = `sc-generation:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const rotatedAt = nowIso();
  await env.SEMANTIC_CACHE_KV.put(key, crypto.randomUUID());
  await env.PLATFORM_DB.prepare(`UPDATE kb_document_deletion_operations SET cache_generation_rotated_at=?,updated_at=?
    WHERE document_id=? AND lease_token=? AND state='pending'`)
    .bind(rotatedAt, rotatedAt, operation.document_id, token)
    .run();
  return { ...operation, cache_generation_rotated_at: rotatedAt };
}

async function deleteVectorPages(
  operation: KnowledgeDocumentDeletion,
  env: KnowledgeDeletionBindings,
  token: string
): Promise<KnowledgeDocumentDeletion> {
  let cursor = operation.vector_cursor;
  for (
    let batch = 0;
    cursor < operation.chunk_count && batch < VECTOR_BATCHES_PER_RUN;
    batch++
  ) {
    const end = Math.min(operation.chunk_count, cursor + VECTOR_BATCH_SIZE);
    const ids = Array.from(
      { length: end - cursor },
      (_, index) => `${operation.document_id}_chunk_${cursor + index}`
    );
    await env.KB_VECTORS.deleteByIds(ids);
    const updatedAt = nowIso();
    const result =
      await env.PLATFORM_DB.prepare(`UPDATE kb_document_deletion_operations SET vector_cursor=?,updated_at=?
      WHERE document_id=? AND lease_token=? AND state='pending' AND vector_cursor=?`)
        .bind(end, updatedAt, operation.document_id, token, cursor)
        .run();
    if (!result.meta.changes) throw new Error("vector_cursor_conflict");
    cursor = end;
  }
  return { ...operation, vector_cursor: cursor };
}

async function deleteR2Pages(
  operation: KnowledgeDocumentDeletion,
  env: KnowledgeDeletionBindings,
  token: string
): Promise<KnowledgeDocumentDeletion> {
  const prefixes = deletionPrefixes(operation);
  let prefixIndex = operation.r2_prefix_index;
  let cursor = operation.r2_cursor ?? undefined;
  for (
    let pageNumber = 0;
    prefixIndex < prefixes.length && pageNumber < R2_PAGES_PER_RUN;
    pageNumber++
  ) {
    const prefix = prefixes[prefixIndex];
    if (!prefix) throw new Error("r2_deletion_prefix_missing");
    const page = await env.KB_BUCKET.list({
      prefix,
      limit: R2_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (page.objects.some((object) => !object.key.startsWith(prefix)))
      throw new Error("r2_deletion_scope_mismatch");
    if (page.objects.length)
      await env.KB_BUCKET.delete(page.objects.map((object) => object.key));
    if (page.truncated) {
      if (!page.cursor || !page.objects.length)
        throw new Error("r2_deletion_cursor_invalid");
      cursor = page.cursor;
    } else {
      prefixIndex++;
      cursor = undefined;
    }
    const updatedAt = nowIso();
    const result =
      await env.PLATFORM_DB.prepare(`UPDATE kb_document_deletion_operations SET r2_prefix_index=?,r2_cursor=?,updated_at=?
      WHERE document_id=? AND lease_token=? AND state='pending'`)
        .bind(
          prefixIndex,
          cursor ?? null,
          updatedAt,
          operation.document_id,
          token
        )
        .run();
    if (!result.meta.changes) throw new Error("r2_cursor_conflict");
  }
  return {
    ...operation,
    r2_prefix_index: prefixIndex,
    r2_cursor: cursor ?? null,
  };
}

async function markPending(
  db: D1Database,
  documentId: string,
  token: string,
  attempt: number,
  errorCode: string | null
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(`UPDATE kb_document_deletion_operations SET lease_token=NULL,lease_until=NULL,
      next_attempt_at=?,last_error=?,updated_at=? WHERE document_id=? AND lease_token=? AND state='pending'`)
    .bind(retryAt(attempt), errorCode, now, documentId, token)
    .run();
}

/** Tombstone first, then retry each external cleanup stage idempotently from a durable cursor. */
export async function processKnowledgeDocumentDeletion(
  env: KnowledgeDeletionBindings,
  documentId: string
): Promise<{ state: "pending" | "complete" | "busy"; attempts?: number }> {
  const db = env.PLATFORM_DB;
  const now = nowIso();
  const token = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + DELETION_LEASE_MS).toISOString();
  const claim = await db
    .prepare(`UPDATE kb_document_deletion_operations SET lease_token=?,lease_until=?,attempts=attempts+1,updated_at=?
    WHERE document_id=? AND state='pending' AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?)`)
    .bind(token, leaseUntil, now, documentId, now, now)
    .run();
  if (!claim.meta.changes) {
    const current = await db
      .prepare(
        "SELECT state,attempts FROM kb_document_deletion_operations WHERE document_id=?"
      )
      .bind(documentId)
      .first<{ state: "pending" | "complete"; attempts: number }>();
    return current?.state === "complete"
      ? { state: "complete", attempts: current.attempts }
      : {
          state: "busy",
          ...(current?.attempts === undefined
            ? {}
            : { attempts: current.attempts }),
        };
  }

  const operation = await db
    .prepare(
      "SELECT * FROM kb_document_deletion_operations WHERE document_id=? AND lease_token=?"
    )
    .bind(documentId, token)
    .first<KnowledgeDocumentDeletion>();
  if (!operation) return { state: "busy" };

  try {
    const mutation = await db
      .prepare(
        "SELECT lease_until FROM kb_document_mutation_leases WHERE document_id=?"
      )
      .bind(documentId)
      .first<{ lease_until: string }>();
    if (mutation && Date.parse(mutation.lease_until) > Date.now()) {
      await markPending(db, documentId, token, operation.attempts, null);
      return { state: "pending", attempts: operation.attempts };
    }

    let current = await rotateSemanticCacheGeneration(operation, env, token);
    current = await deleteVectorPages(current, env, token);
    if (current.vector_cursor < current.chunk_count) {
      await markPending(db, documentId, token, current.attempts, null);
      return { state: "pending", attempts: current.attempts };
    }

    current = await deleteR2Pages(current, env, token);
    if (current.r2_prefix_index < deletionPrefixes(current).length) {
      await markPending(db, documentId, token, current.attempts, null);
      return { state: "pending", attempts: current.attempts };
    }

    const mirrorKey = autoragKey(current);
    await env.KB_BUCKET.delete(mirrorKey);
    if (await env.KB_BUCKET.head(mirrorKey))
      throw new Error("autorag_mirror_delete_unverified");
    const providerMirrorStatus = env.AUTORAG_KB_INSTANCE
      ? "r2_source_deleted_provider_index_unverified"
      : "not_configured";
    const completedAt = nowIso();
    await db.batch([
      // External cleanup can outlast the lease. Every final D1 mutation therefore checks the
      // current token, so an expired worker cannot erase rows after another worker reclaimed it.
      db
        .prepare(`DELETE FROM kb_chunks WHERE document_id=? AND tenant_id=? AND space_id=? AND project_id=?
        AND EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=? AND lease_token=? AND state='pending')`)
        .bind(
          current.document_id,
          current.tenant_id,
          current.space_id,
          current.project_id ?? "_space",
          current.document_id,
          token
        ),
      db
        .prepare(`DELETE FROM kb_documents WHERE id=? AND tenant_id=? AND space_id=? AND status='deleting'
        AND EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=? AND lease_token=? AND state='pending')`)
        .bind(
          current.document_id,
          current.tenant_id,
          current.space_id,
          current.document_id,
          token
        ),
      db
        .prepare(`UPDATE kb_document_deletion_operations SET state='complete',provider_mirror_status=?,lease_token=NULL,
        lease_until=NULL,last_error=NULL,updated_at=?,completed_at=? WHERE document_id=? AND lease_token=? AND state='pending'
        AND NOT EXISTS (SELECT 1 FROM kb_documents WHERE id=? AND tenant_id=? AND space_id=?)`)
        .bind(
          providerMirrorStatus,
          completedAt,
          completedAt,
          current.document_id,
          token,
          current.document_id,
          current.tenant_id,
          current.space_id
        ),
    ]);
    const completed = await db
      .prepare(
        "SELECT state,attempts FROM kb_document_deletion_operations WHERE document_id=?"
      )
      .bind(documentId)
      .first<{ state: "pending" | "complete"; attempts: number }>();
    return completed?.state === "complete"
      ? { state: "complete", attempts: completed.attempts }
      : { state: "pending", attempts: completed?.attempts ?? current.attempts };
  } catch {
    await markPending(
      db,
      documentId,
      token,
      operation.attempts,
      "resource_cleanup_retry_required"
    ).catch(() => undefined);
    return { state: "pending", attempts: operation.attempts };
  }
}

export async function reconcileKnowledgeDocumentDeletions(
  env: KnowledgeDeletionBindings,
  limit = 20
): Promise<number> {
  const now = nowIso();
  const rows =
    await env.PLATFORM_DB.prepare(`SELECT document_id FROM kb_document_deletion_operations
    WHERE state='pending' AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?)
    ORDER BY created_at,document_id LIMIT ?`)
      .bind(now, now, Math.max(1, Math.min(limit, 100)))
      .all<{ document_id: string }>();
  let completed = 0;
  for (const row of rows.results ?? []) {
    const result = await processKnowledgeDocumentDeletion(env, row.document_id);
    if (result.state === "complete") completed++;
  }
  return completed;
}
