import { isSpaceNetworkEgressDenied } from "@naelao/security";

export interface KnowledgeDeletionBindings {
  PLATFORM_DB: D1Database;
  KB_BUCKET: R2Bucket;
  KB_VECTORS: VectorizeIndex;
  SEMANTIC_CACHE_VECTORS: VectorizeIndex;
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
  cache_generation_to_purge: string | null;
  cache_generation_next: string | null;
  cache_cleanup_ids_json: string;
  cache_cleanup_status: "not_started" | "pending" | "complete";
  operation_kind: "document" | "space_cache";
  erasure_request_id: string | null;
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
const SEMANTIC_CACHE_CLEANUP_BATCH_SIZE = 100;
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
      WHERE tenant_id=? AND space_id=? AND (state='pending' OR cache_cleanup_status='pending') LIMIT 1`)
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
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${operation.tenant_id}:${operation.space_id}`)
  );
  const key = `sc-generation:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  let current = operation;
  if (current.cache_cleanup_status === "not_started") {
    const savedGeneration = await env.SEMANTIC_CACHE_KV.get(key);
    const previousGeneration = current.cache_generation_to_purge ??
      (savedGeneration && savedGeneration.length <= 128 ? savedGeneration : "0");
    const nextGeneration = crypto.randomUUID();
    const preparedAt = nowIso();
    const prepared = await env.PLATFORM_DB.prepare(`UPDATE kb_document_deletion_operations
      SET cache_generation_to_purge=?,cache_generation_next=?,cache_cleanup_status='pending',updated_at=?
      WHERE document_id=? AND lease_token=? AND state='pending' AND cache_cleanup_status='not_started'`)
      .bind(previousGeneration, nextGeneration, preparedAt, operation.document_id, token).run();
    if (!prepared.meta.changes) throw new Error("cache_cleanup_prepare_conflict");
    current = { ...current, cache_generation_to_purge: previousGeneration,
      cache_generation_next: nextGeneration, cache_cleanup_status: "pending", updated_at: preparedAt };
  }

  if (current.cache_generation_rotated_at) return current;
  const nextGeneration = current.cache_generation_next;
  if (!nextGeneration || !current.cache_generation_to_purge) throw new Error("cache_generation_receipt_missing");
  // The future generation and old purge target are durable before this write. A lost KV response
  // can therefore safely repeat the exact generation assignment after the next lease.
  await env.SEMANTIC_CACHE_KV.put(key, nextGeneration);
  const rotatedAt = nowIso();
  const rotated = await env.PLATFORM_DB.prepare(`UPDATE kb_document_deletion_operations
    SET cache_generation_rotated_at=?,updated_at=?
    WHERE document_id=? AND lease_token=? AND state='pending' AND cache_generation_next=?`)
    .bind(rotatedAt, rotatedAt, operation.document_id, token, nextGeneration)
    .run();
  if (!rotated.meta.changes) throw new Error("cache_generation_rotation_conflict");
  return { ...current, cache_generation_rotated_at: rotatedAt, updated_at: rotatedAt };
}

function parseSemanticCacheCleanupIds(value: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("cache_cleanup_receipt_invalid"); }
  if (!Array.isArray(parsed) || parsed.length > SEMANTIC_CACHE_CLEANUP_BATCH_SIZE ||
      parsed.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
      new Set(parsed).size !== parsed.length) throw new Error("cache_cleanup_receipt_invalid");
  return parsed as string[];
}

/** Persist a Vectorize result page before deleting either external copy, so retries retain exact IDs. */
async function deleteSemanticCachePage(
  operation: KnowledgeDocumentDeletion,
  env: KnowledgeDeletionBindings,
  token: string
): Promise<{ operation: KnowledgeDocumentDeletion; pending: boolean }> {
  if (operation.cache_cleanup_status === "complete") return { operation, pending: false };
  let ids = parseSemanticCacheCleanupIds(operation.cache_cleanup_ids_json || "[]");
  if (!ids.length) {
    const generation = operation.cache_generation_to_purge;
    if (!generation) throw new Error("cache_generation_purge_target_missing");
    // The configured semantic-cache model produces 1,024-dimensional vectors. A zero query
    // returns an arbitrary bounded page; deleting that page and repeating covers every ID without
    // adding an embedding call or sending cached content back to an AI provider.
    const filter = {
      tenant_id: { $eq: operation.tenant_id },
      space_id: { $eq: operation.space_id },
      ...(generation === "*" ? {} : { generation: { $eq: generation } }),
    };
    const page = await env.SEMANTIC_CACHE_VECTORS.query(new Array(1024).fill(0), {
      topK: SEMANTIC_CACHE_CLEANUP_BATCH_SIZE,
      filter,
      returnMetadata: "none",
    });
    ids = [...new Set((page.matches ?? []).map((match) => match.id))];
    if (ids.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error("cache_cleanup_vector_id_invalid");
    if (!ids.length) {
      const completedAt = nowIso();
      const completed = await env.PLATFORM_DB.prepare(`UPDATE kb_document_deletion_operations
        SET cache_cleanup_status='complete',cache_cleanup_ids_json='[]',updated_at=?
        WHERE document_id=? AND lease_token=? AND state='pending'`)
        .bind(completedAt, operation.document_id, token).run();
      if (!completed.meta.changes) throw new Error("cache_cleanup_complete_conflict");
      return { operation: { ...operation, cache_cleanup_status: "complete", cache_cleanup_ids_json: "[]", updated_at: completedAt }, pending: false };
    }
    const idsJson = JSON.stringify(ids);
    const saved = await env.PLATFORM_DB.prepare(`UPDATE kb_document_deletion_operations
      SET cache_cleanup_ids_json=?,updated_at=?
      WHERE document_id=? AND lease_token=? AND state='pending' AND cache_cleanup_ids_json='[]'`)
      .bind(idsJson, nowIso(), operation.document_id, token).run();
    if (!saved.meta.changes) throw new Error("cache_cleanup_page_conflict");
    operation = { ...operation, cache_cleanup_ids_json: idsJson };
  }

  await env.SEMANTIC_CACHE_VECTORS.deleteByIds(ids);
  await Promise.all(ids.map((id) => env.SEMANTIC_CACHE_KV.delete(`sc:${id}`)));
  const updatedAt = nowIso();
  const cleared = await env.PLATFORM_DB.prepare(`UPDATE kb_document_deletion_operations
    SET cache_cleanup_ids_json='[]',updated_at=?
    WHERE document_id=? AND lease_token=? AND state='pending' AND cache_cleanup_ids_json=?`)
    .bind(updatedAt, operation.document_id, token, JSON.stringify(ids)).run();
  if (!cleared.meta.changes) throw new Error("cache_cleanup_page_clear_conflict");
  return { operation: { ...operation, cache_cleanup_ids_json: "[]", updated_at: updatedAt }, pending: true };
}

async function completeSpaceCacheErasure(
  db: D1Database,
  operation: KnowledgeDocumentDeletion,
  token: string
): Promise<boolean> {
  if (!operation.erasure_request_id) throw new Error("cache_erasure_request_missing");
  const completedAt = nowIso();
  const results = await db.batch([
    db.prepare(`UPDATE kb_document_deletion_operations SET state='complete',lease_token=NULL,lease_until=NULL,
      last_error=NULL,updated_at=?,completed_at=? WHERE document_id=? AND lease_token=? AND state='pending'
      AND cache_cleanup_status='complete'`).bind(completedAt, completedAt, operation.document_id, token),
    db.prepare(`UPDATE gdpr_requests SET cache_cleanup_status=CASE WHEN EXISTS (
      SELECT 1 FROM kb_document_deletion_operations WHERE erasure_request_id=? AND state='pending'
    ) THEN 'pending' ELSE 'complete' END,updated_at=? WHERE id=? AND tenant_id=? AND request_type='erasure'`)
      .bind(operation.erasure_request_id, completedAt, operation.erasure_request_id, operation.tenant_id),
  ]);
  return results[0]?.meta.changes === 1;
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
    if (current.operation_kind === "space_cache") {
      if (!current.erasure_request_id) throw new Error("cache_erasure_request_missing");
      const request = await db.prepare(`SELECT status FROM gdpr_requests
        WHERE id=? AND tenant_id=? AND request_type='erasure'`)
        .bind(current.erasure_request_id, current.tenant_id)
        .first<{ status: string }>();
      if (!request || !["processing", "completed"].includes(request.status)) {
        throw new Error("cache_erasure_request_unavailable");
      }
      // Generation rotation is a KV-only read barrier. While the Space is still active, keep
      // external Vectorize cleanup inside the Space's configured network policy. Once an
      // erasure is complete, the remaining deletion-only work may finish even after the Space
      // row itself has been removed; it carries IDs but no cached content across the boundary.
      if (request.status !== "completed" &&
          await isSpaceNetworkEgressDenied(db, current.space_id)) {
        await markPending(db, documentId, token, current.attempts, "space_egress_policy");
        return { state: "pending", attempts: current.attempts };
      }
      const cachePage = await deleteSemanticCachePage(current, env, token);
      current = cachePage.operation;
      if (cachePage.pending) {
        await markPending(db, documentId, token, current.attempts, null);
        return { state: "pending", attempts: current.attempts };
      }
      const completed = await completeSpaceCacheErasure(db, current, token);
      return completed
        ? { state: "complete", attempts: current.attempts }
        : { state: "pending", attempts: current.attempts };
    }

    const cachePage = await deleteSemanticCachePage(current, env, token);
    current = cachePage.operation;
    if (cachePage.pending) {
      await markPending(db, documentId, token, current.attempts, null);
      return { state: "pending", attempts: current.attempts };
    }
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
  // An older Worker can finish a row during migration-before-code rollout without knowing the
  // new cleanup columns. Keep cache reads fail-closed above and reopen that bounded work here.
  await env.PLATFORM_DB.prepare(`UPDATE kb_document_deletion_operations
    SET state='pending',next_attempt_at=?,lease_token=NULL,lease_until=NULL,updated_at=?
    WHERE state='complete' AND cache_cleanup_status='pending'`)
    .bind(now, now).run();
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
