// G-Q02: Daily Cleanup Cron Worker — sweeps expired sessions, failed docs, expired keys
interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  KB_BUCKET: R2Bucket;
  KB_VECTORS: VectorizeIndex;
}

async function cleanOldSessions(db: D1Database): Promise<number> {
  // Delete sessions with no messages older than 90 days
  const result = await db.prepare(
    `DELETE FROM sessions WHERE created_at < datetime('now', '-90 days')
     AND id NOT IN (SELECT DISTINCT session_id FROM messages WHERE session_id IS NOT NULL)`
  ).run();
  return result.meta.changes ?? 0;
}

async function cleanFailedDocs(db: D1Database, bucket: R2Bucket, vectors: VectorizeIndex): Promise<number> {
  // Failed KB docs older than 7 days — clean up
  const { results: failedDocs } = await db.prepare(
    `SELECT id, space_id FROM kb_documents WHERE status = 'failed' AND updated_at < datetime('now', '-7 days') LIMIT 100`
  ).all<{ id: string; space_id: string }>();

  let cleaned = 0;
  for (const doc of failedDocs) {
    try {
      // Delete any partial R2 objects
      const prefix = `kb/${doc.space_id}/${doc.id}/`;
      const listed = await bucket.list({ prefix });
      await Promise.all(listed.objects.map((o) => bucket.delete(o.key)));
      // Delete any partial vectors
      await vectors.deleteByIds([`${doc.id}_chunk_0`]);
      // Delete D1 record
      await db.prepare("DELETE FROM kb_documents WHERE id = ?").bind(doc.id).run();
      cleaned++;
    } catch {
      // best-effort, continue
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

async function cleanExpiredIdempotencyKeys(db: D1Database): Promise<number> {
  const result = await db.prepare(
    "DELETE FROM idempotency_keys WHERE expires_at < datetime('now') LIMIT 1000"
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
      cleanExpiredApiKeys(env.PLATFORM_DB).then((n) => console.log(`[sweeper] Cleaned ${n} expired API keys`)),
      cleanExpiredIdempotencyKeys(env.PLATFORM_DB).then((n) => console.log(`[sweeper] Cleaned ${n} expired idempotency keys`)),
    ]));
  },
} satisfies ExportedHandler<Env>;
