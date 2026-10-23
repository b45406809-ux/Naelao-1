import type { ProvisionMessage } from "./create-space.js";

type Db = Pick<D1Database, "prepare">;
type QueueSender = Pick<Queue<ProvisionMessage>, "send">;

/** Deliver one durable queue intent. A send followed by a lost response can produce a duplicate;
 * the provisioner's per-space lease and status checks make that delivery safe. */
export async function deliverProvisioningOutboxEntry(
  db: Db,
  queue: QueueSender,
  spaceId: string,
): Promise<boolean> {
  const entry = await db.prepare(
    `SELECT tenant_id, payload_json, attempt_count FROM space_provisioning_outbox
     WHERE space_id = ? AND status = 'pending'`,
  ).bind(spaceId).first<{ tenant_id: string; payload_json: string; attempt_count: number }>();
  if (!entry) return false;

  try {
    const message = JSON.parse(entry.payload_json) as ProvisionMessage;
    if (message.type !== "space_provision" || message.spaceId !== spaceId || message.tenantId !== entry.tenant_id) {
      throw new Error("invalid_provisioning_outbox_payload");
    }
    await queue.send(message);
    await db.prepare(
      `UPDATE space_provisioning_outbox SET status = 'sent', sent_at = datetime('now'),
       updated_at = datetime('now'), last_error = NULL WHERE space_id = ? AND status = 'pending'`,
    ).bind(spaceId).run();
    return true;
  } catch {
    const attempts = entry.attempt_count + 1;
    const seconds = Math.min(3600, 30 * 2 ** Math.min(attempts - 1, 7));
    await db.prepare(
      `UPDATE space_provisioning_outbox SET attempt_count = ?,
       next_attempt_at = datetime('now', ?), last_error = 'queue_send_failed',
       updated_at = datetime('now') WHERE space_id = ? AND status = 'pending'`,
    ).bind(attempts, `+${seconds} seconds`, spaceId).run();
    return false;
  }
}

/** Bounded scheduled retry; queue delivery is at-least-once and consumer operations are idempotent. */
export async function dispatchPendingProvisioningOutbox(
  db: Db,
  queue: QueueSender,
  limit = 25,
): Promise<{ sent: number; deferred: number }> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const due = await db.prepare(
    `SELECT space_id FROM space_provisioning_outbox
     WHERE status = 'pending' AND next_attempt_at <= datetime('now')
     ORDER BY next_attempt_at, created_at, space_id LIMIT ?`,
  ).bind(boundedLimit).all<{ space_id: string }>();
  let sent = 0;
  let deferred = 0;
  for (const row of due.results ?? []) {
    if (await deliverProvisioningOutboxEntry(db, queue, row.space_id)) sent++;
    else deferred++;
  }
  await db.prepare(
    `DELETE FROM space_provisioning_outbox WHERE space_id IN (
       SELECT space_id FROM space_provisioning_outbox
       WHERE status = 'sent' AND sent_at < datetime('now', '-30 days') LIMIT 100
     )`,
  ).run();
  return { sent, deferred };
}
