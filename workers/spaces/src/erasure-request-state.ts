export interface ErasureQueueMessage {
  type: "data.erasure";
  orgId: string;
  requestedBy: string;
  reason: string;
  requestId: string;
}

/** Atomically save an erasure request and its durable Queue outbox entry. */
export async function createPendingErasureRequest(
  db: Pick<D1Database, "batch" | "prepare">,
  queue: Pick<Queue<ErasureQueueMessage>, "send">,
  request: { id: string; tenantId: string; userId: string; reason: string },
): Promise<boolean> {
  const message: ErasureQueueMessage = {
      type: "data.erasure",
      orgId: request.tenantId,
      requestedBy: request.userId,
      reason: request.reason,
      requestId: request.id,
  };
  const inserted = await db.batch([
    db.prepare(
      `INSERT INTO gdpr_requests (id, tenant_id, request_type, subject_type, subject_id, requested_by, status)
       SELECT ?, ?, 'erasure', 'org_member', ?, ?, 'pending'
       WHERE NOT EXISTS (
         SELECT 1 FROM gdpr_requests
         WHERE tenant_id = ? AND request_type = 'erasure' AND status IN ('pending', 'processing')
       )`,
    ).bind(request.id, request.tenantId, request.userId, request.userId, request.tenantId),
    db.prepare(
      `INSERT INTO gdpr_erasure_outbox (request_id, tenant_id, payload_json)
       SELECT ?, ?, ? WHERE changes() = 1`,
    ).bind(request.id, request.tenantId, JSON.stringify(message)),
  ]);
  if (inserted[0]?.meta.changes !== 1) return false;
  await deliverErasureOutboxEntry(db, queue, request.id);
  return true;
}

/** Retry due Queue sends in bounded batches; duplicate delivery is safe by requestId CAS. */
export async function dispatchPendingErasureOutbox(
  db: Pick<D1Database, "prepare">,
  queue: Pick<Queue<ErasureQueueMessage>, "send">,
  limit = 25,
): Promise<{ sent: number; deferred: number }> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const due = await db.prepare(
    `SELECT request_id FROM gdpr_erasure_outbox
     WHERE status = 'pending' AND next_attempt_at <= datetime('now')
     ORDER BY next_attempt_at, created_at, request_id LIMIT ?`,
  ).bind(boundedLimit).all<{ request_id: string }>();
  let sent = 0;
  let deferred = 0;
  for (const row of due.results ?? []) {
    if (await deliverErasureOutboxEntry(db, queue, row.request_id)) sent++;
    else deferred++;
  }
  await db.prepare(
    `DELETE FROM gdpr_erasure_outbox
     WHERE request_id IN (
       SELECT request_id FROM gdpr_erasure_outbox
       WHERE status = 'sent' AND sent_at < datetime('now', '-30 days') LIMIT 100
     )`,
  ).run();
  return { sent, deferred };
}

async function deliverErasureOutboxEntry(
  db: Pick<D1Database, "prepare">,
  queue: Pick<Queue<ErasureQueueMessage>, "send">,
  requestId: string,
): Promise<boolean> {
  const entry = await db.prepare(
    `SELECT payload_json, attempt_count FROM gdpr_erasure_outbox
     WHERE request_id = ? AND status = 'pending'`,
  ).bind(requestId).first<{ payload_json: string; attempt_count: number }>();
  if (!entry) return false;
  try {
    const message = JSON.parse(entry.payload_json) as ErasureQueueMessage;
    if (message.type !== "data.erasure" || message.requestId !== requestId) {
      throw new Error("invalid_outbox_payload");
    }
    await queue.send(message);
    await db.prepare(
      `UPDATE gdpr_erasure_outbox SET status = 'sent', sent_at = datetime('now'),
       updated_at = datetime('now'), last_error = NULL WHERE request_id = ? AND status = 'pending'`,
    ).bind(requestId).run();
    return true;
  } catch {
    const attemptCount = entry.attempt_count + 1;
    const retrySeconds = Math.min(3600, 30 * 2 ** Math.min(attemptCount - 1, 7));
    await db.prepare(
      `UPDATE gdpr_erasure_outbox SET attempt_count = ?,
       next_attempt_at = datetime('now', ?), last_error = 'queue_send_failed',
       updated_at = datetime('now') WHERE request_id = ? AND status = 'pending'`,
    ).bind(attemptCount, `+${retrySeconds} seconds`, requestId).run();
    return false;
  }
}

export async function cancelPendingErasure(
  db: Pick<D1Database, "batch" | "prepare">,
  tenantId: string,
  userId: string,
  requestId: string,
): Promise<boolean> {
  const results = await db.batch([
    db.prepare(
      `UPDATE gdpr_requests SET status = 'cancelled', updated_at = datetime('now')
       WHERE id = ? AND tenant_id = ? AND requested_by = ? AND request_type = 'erasure' AND status = 'pending'`,
    ).bind(requestId, tenantId, userId),
    db.prepare(
      `UPDATE orgs SET status = 'active', suspension_reason = NULL
       WHERE id = ? AND status = 'suspended' AND suspension_reason = 'erasure'
         AND changes() = 1
         AND EXISTS (SELECT 1 FROM gdpr_requests WHERE id = ? AND tenant_id = ? AND status = 'cancelled')`,
    ).bind(tenantId, requestId, tenantId),
    db.prepare(
      `UPDATE spaces SET status = 'active', suspension_reason = NULL, updated_at = datetime('now')
       WHERE tenant_id = ? AND status = 'suspended' AND suspension_reason = 'erasure'
         AND changes() = 1
         AND EXISTS (SELECT 1 FROM gdpr_requests WHERE id = ? AND tenant_id = ? AND status = 'cancelled')`,
    ).bind(tenantId, requestId, tenantId),
    db.prepare(
      `UPDATE gdpr_erasure_outbox SET status = 'cancelled', updated_at = datetime('now')
       WHERE request_id = ? AND tenant_id = ? AND status = 'pending'
         AND EXISTS (SELECT 1 FROM gdpr_requests WHERE id = ? AND tenant_id = ? AND status = 'cancelled')`,
    ).bind(requestId, tenantId, requestId, tenantId),
  ]);
  return results[0]?.meta.changes === 1;
}
