/** Atomically cancel a cooling-off request and release only the holds it owns. */
export async function createPendingErasureRequest(
  db: Pick<D1Database, "prepare">,
  queue: Pick<Queue, "send">,
  request: { id: string; tenantId: string; userId: string; reason: string },
): Promise<boolean> {
  const inserted = await db.prepare(
    `INSERT INTO gdpr_requests (id, tenant_id, request_type, subject_type, subject_id, requested_by, status)
     SELECT ?, ?, 'erasure', 'org_member', ?, ?, 'pending'
     WHERE NOT EXISTS (
       SELECT 1 FROM gdpr_requests
       WHERE tenant_id = ? AND request_type = 'erasure' AND status IN ('pending', 'processing')
     )`,
  ).bind(request.id, request.tenantId, request.userId, request.userId, request.tenantId).run();
  if (inserted.meta.changes !== 1) return false;
  try {
    await queue.send({
      type: "data.erasure",
      orgId: request.tenantId,
      requestedBy: request.userId,
      reason: request.reason,
      requestId: request.id,
    });
  } catch (error) {
    await db.prepare(
      "UPDATE gdpr_requests SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
    ).bind(request.id).run();
    throw error;
  }
  return true;
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
  ]);
  return results[0]?.meta.changes === 1;
}
