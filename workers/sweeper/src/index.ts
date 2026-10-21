// G-Q02: Daily Cleanup Cron Worker — sweeps expired sessions, failed docs, expired keys
interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  KB_BUCKET: R2Bucket;
  KB_VECTORS: VectorizeIndex;
}

const VECTOR_DELETE_BATCH_SIZE = 100;
const MAX_DOCUMENT_CHUNKS = 12_000;
const R2_DELETE_BATCH_SIZE = 100;
const MAX_R2_PAGES_PER_PASS = 10;

/** Read a bounded, ordered slice after the last examined key, then advance the cursor.
 * Once the end is reached the next pass wraps to the beginning. Cursor advancement happens
 * before external cleanup so a provider failure cannot pin the scan at the same first row.
 */
export async function selectFairSweepBatch<T>(
  db: D1Database,
  cursorName: string,
  select: (after: string | null) => D1PreparedStatement,
  key: (row: T) => string,
): Promise<T[]> {
  const stored = await db.prepare("SELECT cursor_value FROM sweeper_cursors WHERE name = ?")
    .bind(cursorName).first<{ cursor_value: string }>();
  let rows = (await select(stored?.cursor_value ?? null).all<T>()).results;
  if (rows.length === 0 && stored?.cursor_value) rows = (await select(null).all<T>()).results;
  if (rows.length > 0) {
    await db.prepare(
      `INSERT INTO sweeper_cursors (name, cursor_value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(name) DO UPDATE SET cursor_value = excluded.cursor_value, updated_at = excluded.updated_at`
    ).bind(cursorName, key(rows[rows.length - 1]!)).run();
  }
  return rows;
}

function validChunkCount(value: number | null): number {
  if (value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DOCUMENT_CHUNKS) {
    throw new Error("Invalid knowledge document chunk count");
  }
  return value;
}

async function deleteDocumentVectors(
  vectors: VectorizeIndex,
  documentId: string,
  chunkCount: number | null
): Promise<void> {
  const count = validChunkCount(chunkCount);
  for (let start = 0; start < count; start += VECTOR_DELETE_BATCH_SIZE) {
    const end = Math.min(start + VECTOR_DELETE_BATCH_SIZE, count);
    const ids = Array.from({ length: end - start }, (_, offset) =>
      `${documentId}_chunk_${start + offset}`
    );
    await vectors.deleteByIds(ids);
  }
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<boolean> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_R2_PAGES_PER_PASS; page++) {
    const options: R2ListOptions = cursor === undefined
      ? { prefix, limit: 1000 }
      : { prefix, cursor, limit: 1000 };
    const listed = await bucket.list(options);
    const keys = listed.objects.map((object) => object.key);
    for (let start = 0; start < keys.length; start += R2_DELETE_BATCH_SIZE) {
      await Promise.all(
        keys.slice(start, start + R2_DELETE_BATCH_SIZE).map((key) => bucket.delete(key))
      );
    }
    if (!listed.truncated) return true;
    const nextCursor = listed.cursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("R2 cleanup returned a missing or repeated cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return false;
}

function documentR2Prefix(spaceId: string, projectId: string | null, documentId: string): string {
  return `kb/${spaceId}/${projectId ?? "_space"}/${documentId}/`;
}

function autoragDocumentKey(spaceId: string, projectId: string | null, documentId: string): string {
  return `autorag/${spaceId}/${projectId ?? "_space"}/${documentId}.md`;
}

export async function cleanOrphanedKnowledgeChunks(
  db: D1Database,
  bucket: R2Bucket,
  vectors: VectorizeIndex
): Promise<number> {
  const orphanedDocs = await selectFairSweepBatch<{
    id: string; tenant_id: string; space_id: string; project_id: string; chunk_count: number;
  }>(
    db,
    "orphaned_kb_chunks",
    (after) => db.prepare(
    `SELECT kc.document_id AS id, kc.tenant_id, kc.space_id, kc.project_id,
       MAX(kc.chunk_index) + 1 AS chunk_count
     FROM kb_chunks kc
     LEFT JOIN kb_documents d ON d.id = kc.document_id
     WHERE d.id IS NULL AND kc.document_id > COALESCE(?, '')
     GROUP BY kc.document_id, kc.tenant_id, kc.space_id, kc.project_id
     ORDER BY kc.document_id ASC LIMIT 100`
    ).bind(after),
    (row: { id: string }) => row.id,
  );

  let cleaned = 0;
  for (const doc of orphanedDocs) {
    try {
      if (!(await deleteR2Prefix(bucket, documentR2Prefix(doc.space_id, doc.project_id, doc.id)))) continue;
      await bucket.delete(autoragDocumentKey(doc.space_id, doc.project_id, doc.id));
      await deleteDocumentVectors(vectors, doc.id, doc.chunk_count);
      const result = await db.prepare(
        "DELETE FROM kb_chunks WHERE document_id = ? AND tenant_id = ? AND space_id = ? AND project_id = ?"
      ).bind(doc.id, doc.tenant_id, doc.space_id, doc.project_id).run();
      cleaned += result.meta.changes ?? 0;
    } catch (error) {
      console.warn(`[sweeper] Failed to clean orphaned KB document ${doc.id}:`, error);
    }
  }
  return cleaned;
}

export async function cleanOldSessions(db: D1Database): Promise<number> {
  // Clean ended sessions from the D1 active_sessions registry (messages live in SpaceDO SQLite)
  const oldThreadSessions = await db.prepare(
    `SELECT DISTINCT thread_id, tenant_id FROM thread_sessions
     WHERE status = 'ended' AND ended_at < datetime('now', '-90 days') LIMIT 1000`
  ).all<{ thread_id: string; tenant_id: string }>();
  const statements = [
    db.prepare(`DELETE FROM active_sessions WHERE rowid IN (
       SELECT rowid FROM active_sessions
       WHERE status = 'ended' AND ended_at < datetime('now', '-90 days') LIMIT 1000
     )`),
    // Also clean ended thread_sessions entries older than 90 days. Recount their parents in
    // the same D1 batch so the denormalized session_count cannot drift after retention.
    db.prepare(`DELETE FROM thread_sessions WHERE rowid IN (
       SELECT rowid FROM thread_sessions
       WHERE status = 'ended' AND ended_at < datetime('now', '-90 days') LIMIT 1000
     )`),
    ...oldThreadSessions.results.map(({ thread_id, tenant_id }) => db.prepare(
      `UPDATE threads SET session_count = (
         SELECT COUNT(*) FROM thread_sessions WHERE thread_id = ? AND tenant_id = ?
       ) WHERE id = ? AND tenant_id = ?`
    ).bind(thread_id, tenant_id, thread_id, tenant_id)),
  ];
  const results = await db.batch(statements);
  return (results[0]?.meta.changes ?? 0) + (results[1]?.meta.changes ?? 0);
}

export async function cleanFailedDocs(db: D1Database, bucket: R2Bucket, vectors: VectorizeIndex): Promise<number> {
  // Failed KB docs older than 7 days — clean up
  const failedDocs = await selectFairSweepBatch<{
    id: string; tenant_id: string; space_id: string; project_id: string | null; chunk_count: number | null;
  }>(
    db,
    "failed_kb_documents",
    (after) => db.prepare(
      `SELECT id, tenant_id, space_id, project_id, chunk_count FROM kb_documents
       WHERE status = 'failed' AND updated_at < datetime('now', '-7 days')
         AND id > COALESCE(?, '') ORDER BY id ASC LIMIT 100`
    ).bind(after),
    (row: { id: string }) => row.id,
  );

  let cleaned = 0;
  for (const doc of failedDocs) {
    try {
      // Delete any partial R2 objects (paginated)
      const prefix = documentR2Prefix(doc.space_id, doc.project_id, doc.id);
      if (!(await deleteR2Prefix(bucket, prefix))) continue;
      await bucket.delete(autoragDocumentKey(doc.space_id, doc.project_id, doc.id));
      await deleteDocumentVectors(vectors, doc.id, doc.chunk_count);

      await db.prepare(
        "DELETE FROM kb_chunks WHERE document_id = ? AND tenant_id = ? AND space_id = ? AND project_id = ?"
      ).bind(doc.id, doc.tenant_id, doc.space_id, doc.project_id ?? "_space").run();

      // Delete D1 record
      await db.prepare("DELETE FROM kb_documents WHERE id = ?").bind(doc.id).run();
      cleaned++;
    } catch (error) {
      // best-effort, continue
      console.warn(`[sweeper] Failed to clean failed KB document ${doc.id}:`, error);
    }
  }
  return cleaned;
}

// G-D07: Cascade-delete resources for soft-deleted spaces (R2, Vectorize, D1)
export async function cleanDeletedSpaces(db: D1Database, bucket: R2Bucket, vectors: VectorizeIndex): Promise<number> {
  // Find deleted spaces with either non-purged documents or leftover D1 chunks, including
  // chunks left behind by older sweeper versions that already marked their document purged.
  const deletedSpaces = await selectFairSweepBatch(
    db,
    "deleted_spaces",
    (after) => db.prepare(
    `SELECT s.id AS space_id FROM spaces s
     WHERE s.status = 'deleted' AND (
       EXISTS (SELECT 1 FROM kb_documents kd WHERE kd.space_id = s.id AND kd.status != 'purged')
       OR EXISTS (SELECT 1 FROM kb_chunks kc WHERE kc.space_id = s.id)
     )
       AND s.id > COALESCE(?, '')
     ORDER BY s.id ASC LIMIT 20`
    ).bind(after),
    (row: { space_id: string }) => row.space_id,
  );

  let cleaned = 0;
  for (const { space_id: spaceId } of deletedSpaces) {
    try {
      // Get all KB documents for this space
      const docs = await selectFairSweepBatch<{
        id: string; tenant_id: string; project_id: string | null; chunk_count: number | null;
      }>(
        db,
        `deleted_space_docs:${spaceId}`,
        (after) => db.prepare(
        `SELECT d.id, d.tenant_id, d.project_id, d.chunk_count FROM kb_documents d
         WHERE d.space_id = ? AND (
           d.status != 'purged'
           OR EXISTS (SELECT 1 FROM kb_chunks kc WHERE kc.document_id = d.id)
         ) AND d.id > COALESCE(?, '') ORDER BY d.id ASC LIMIT 200`
        ).bind(spaceId, after),
        (doc: { id: string }) => doc.id,
      );

      let allDocumentsComplete = true;
      for (const doc of docs) {
        // Delete R2 objects (paginated — G-E08 fix)
        const prefix = documentR2Prefix(spaceId, doc.project_id, doc.id);
        if (!(await deleteR2Prefix(bucket, prefix))) {
          allDocumentsComplete = false;
          continue;
        }
        await bucket.delete(autoragDocumentKey(spaceId, doc.project_id, doc.id));
        await deleteDocumentVectors(vectors, doc.id, doc.chunk_count);

        await db.prepare(
          "DELETE FROM kb_chunks WHERE document_id = ? AND tenant_id = ? AND space_id = ? AND project_id = ?"
        ).bind(doc.id, doc.tenant_id, spaceId, doc.project_id ?? "_space").run();

        // Mark document as purged
        await db.prepare(
          `UPDATE kb_documents SET status = 'purged', updated_at = datetime('now') WHERE id = ?`
        ).bind(doc.id).run();
      }

      if (!allDocumentsComplete) continue;

      if (!(await deleteR2Prefix(bucket, `kb/${spaceId}/`))) continue;
      if (!(await deleteR2Prefix(bucket, `autorag/${spaceId}/`))) continue;
      await db.prepare("DELETE FROM kb_chunks WHERE space_id = ?").bind(spaceId).run();

      // Clean up D1 session records for deleted space
      await db.prepare(
        `DELETE FROM active_sessions WHERE space_id = ?`
      ).bind(spaceId).run();

      await db.prepare(
        `DELETE FROM thread_sessions WHERE space_id = ?`
      ).bind(spaceId).run();
      await db.prepare(
        "UPDATE threads SET session_count = 0 WHERE space_id = ?"
      ).bind(spaceId).run();

      cleaned++;
    } catch (error) {
      // best-effort, continue with next space
      console.warn(`[sweeper] Failed to clean deleted space ${spaceId}:`, error);
    }
  }
  return cleaned;
}

export async function cleanExpiredApiKeys(db: D1Database): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM api_keys WHERE rowid IN (
       SELECT rowid FROM api_keys
       WHERE expires_at IS NOT NULL AND julianday(expires_at) < julianday('now') LIMIT 1000
     )`
  ).run();
  return result.meta.changes ?? 0;
}

export async function cleanExpiredIdempotencyKeys(db: D1Database): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM idempotency_keys WHERE rowid IN (
       SELECT rowid FROM idempotency_keys WHERE julianday(expires_at) < julianday('now') LIMIT 1000
     )`
  ).run();
  return result.meta.changes ?? 0;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
    return new Response(JSON.stringify({ ok: true, service: "sweeper" }), {
      headers: { "Content-Type": "application/json" },
    });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");

    const startedAt = new Date().toISOString();
    console.log(`[sweeper] Starting cleanup at ${startedAt}`);

    ctx.waitUntil(Promise.all([
      cleanOldSessions(env.PLATFORM_DB).then((n) => console.log(`[sweeper] Cleaned ${n} old sessions`)),
      cleanFailedDocs(env.PLATFORM_DB, env.KB_BUCKET, env.KB_VECTORS).then((n) => console.log(`[sweeper] Cleaned ${n} failed docs`)),
      cleanDeletedSpaces(env.PLATFORM_DB, env.KB_BUCKET, env.KB_VECTORS).then((n) => console.log(`[sweeper] Cascade-cleaned ${n} deleted spaces`)),
      cleanExpiredApiKeys(env.PLATFORM_DB).then((n) => console.log(`[sweeper] Cleaned ${n} expired API keys`)),
      cleanExpiredIdempotencyKeys(env.PLATFORM_DB).then((n) => console.log(`[sweeper] Cleaned ${n} expired idempotency keys`)),
      cleanOrphanedKnowledgeChunks(env.PLATFORM_DB, env.KB_BUCKET, env.KB_VECTORS).then((n) => console.log(`[sweeper] Cleaned ${n} orphaned KB chunks`)),
    ]));
  },
} satisfies ExportedHandler<Env>;
