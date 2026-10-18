// G-Q02: Daily Cleanup Cron Worker — sweeps expired sessions, failed docs, expired keys
interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  KB_BUCKET: R2Bucket;
  KB_VECTORS: VectorizeIndex;
}

async function cleanOldSessions(db: D1Database): Promise<number> {
  // Clean ended sessions from the D1 active_sessions registry (messages live in SpaceDO SQLite)
  const result = await db.prepare(
    `DELETE FROM active_sessions WHERE status = 'ended' AND ended_at < datetime('now', '-90 days')`
  ).run();
  // Also clean ended thread_sessions entries older than 90 days
  const result2 = await db.prepare(
    `DELETE FROM thread_sessions WHERE status = 'ended' AND ended_at < datetime('now', '-90 days')`
  ).run();
  return (result.meta.changes ?? 0) + (result2.meta.changes ?? 0);
}

async function cleanFailedDocs(db: D1Database, bucket: R2Bucket, vectors: VectorizeIndex): Promise<number> {
  // Failed KB docs older than 7 days — clean up
  const { results: failedDocs } = await db.prepare(
    `SELECT id, space_id, chunk_count FROM kb_documents WHERE status = 'failed' AND updated_at < datetime('now', '-7 days') LIMIT 100`
  ).all<{ id: string; space_id: string; chunk_count: number }>();

  let cleaned = 0;
  for (const doc of failedDocs) {
    try {
      // Delete any partial R2 objects (paginated)
      const prefix = `kb/${doc.space_id}/${doc.id}/`;
      let cursor: string | undefined;
      do {
        const listOpts: R2ListOptions = cursor !== undefined ? { prefix, cursor } : { prefix };
        const listed: R2Objects = await bucket.list(listOpts);
        if (listed.objects.length > 0) {
          await Promise.all(listed.objects.map((o) => bucket.delete(o.key)));
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);

      // Delete all partial vectors by chunk count (or attempt up to chunk_count)
      const chunkCount = doc.chunk_count ?? 0;
      if (chunkCount > 0) {
        const vectorIds = Array.from({ length: chunkCount }, (_, i) => `${doc.id}_chunk_${i}`);
        const BATCH = 100;
        for (let i = 0; i < vectorIds.length; i += BATCH) {
          await vectors.deleteByIds(vectorIds.slice(i, i + BATCH));
        }
      }

      // Delete D1 record
      await db.prepare("DELETE FROM kb_documents WHERE id = ?").bind(doc.id).run();
      cleaned++;
    } catch {
      // best-effort, continue
    }
  }
  return cleaned;
}

// G-D07: Cascade-delete resources for soft-deleted spaces (R2, Vectorize, D1)
async function cleanDeletedSpaces(db: D1Database, bucket: R2Bucket, vectors: VectorizeIndex): Promise<number> {
  // Find soft-deleted spaces that still have indexed KB documents
  const { results: deletedSpaces } = await db.prepare(
    `SELECT DISTINCT kd.space_id FROM kb_documents kd
     INNER JOIN spaces s ON s.id = kd.space_id
     WHERE s.status = 'deleted' AND kd.status != 'purged'
     LIMIT 20`
  ).all<{ space_id: string }>();

  let cleaned = 0;
  for (const { space_id: spaceId } of deletedSpaces) {
    try {
      // Get all KB documents for this space
      const { results: docs } = await db.prepare(
        `SELECT id, chunk_count FROM kb_documents WHERE space_id = ? AND status != 'purged' LIMIT 200`
      ).bind(spaceId).all<{ id: string; chunk_count: number }>();

      for (const doc of docs) {
        // Delete R2 objects (paginated — G-E08 fix)
        const prefix = `kb/${spaceId}/${doc.id}/`;
        let cursor: string | undefined;
        do {
          const listOpts: R2ListOptions = cursor !== undefined ? { prefix, cursor } : { prefix };
          const listed: R2Objects = await bucket.list(listOpts);
          if (listed.objects.length > 0) {
            await Promise.all(listed.objects.map((o) => bucket.delete(o.key)));
          }
          cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);

        // Delete Vectorize vectors
        const chunkCount = doc.chunk_count ?? 0;
        if (chunkCount > 0) {
          const vectorIds = Array.from({ length: chunkCount }, (_, i) => `${doc.id}_chunk_${i}`);
          const BATCH = 100;
          for (let i = 0; i < vectorIds.length; i += BATCH) {
            await vectors.deleteByIds(vectorIds.slice(i, i + BATCH));
          }
        }

        // Mark document as purged
        await db.prepare(
          `UPDATE kb_documents SET status = 'purged', updated_at = datetime('now') WHERE id = ?`
        ).bind(doc.id).run();
      }

      // Clean up D1 session records for deleted space
      await db.prepare(
        `DELETE FROM active_sessions WHERE space_id = ?`
      ).bind(spaceId).run();

      await db.prepare(
        `DELETE FROM thread_sessions WHERE space_id = ?`
      ).bind(spaceId).run();

      cleaned++;
    } catch {
      // best-effort, continue with next space
    }
  }
  return cleaned;
}

async function cleanExpiredApiKeys(db: D1Database): Promise<number> {
  const result = await db.prepare(
    "DELETE FROM api_keys WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
  ).run();
  return result.meta.changes ?? 0;
}

export async function cleanExpiredIdempotencyKeys(db: D1Database): Promise<number> {
  const result = await db.prepare(
    "DELETE FROM idempotency_keys WHERE julianday(expires_at) < julianday('now') LIMIT 1000"
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
    ]));
  },
} satisfies ExportedHandler<Env>;
