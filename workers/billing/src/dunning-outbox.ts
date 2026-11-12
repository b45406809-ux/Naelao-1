export interface DunningOutboxEnv {
  PLATFORM_DB: D1Database;
  DUNNING_EVENTS: Queue;
}

interface DunningOutboxRow {
  workflow_id: string;
  tenant_id: string;
  payload_json: string;
  attempt_count: number;
}

function validDunningPayload(value: unknown, row: DunningOutboxRow): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const identityValid = body.scope === "platform_subscription"
    ? body.orgId === row.tenant_id && typeof body.orgId === "string" && body.orgId.length > 0
    : body.scope === "product_user_subscription" && typeof body.productId === "string" && body.productId.length > 0 &&
      typeof body.endUserId === "string" && body.endUserId.length > 0;
  return body.type === "dunning" && identityValid &&
    body.workflow_id === row.workflow_id && typeof body.workflow_id === "string" && /^dunning-[a-f0-9]{64}$/.test(body.workflow_id) &&
    typeof body.subscriptionId === "string" && body.subscriptionId.length > 0 &&
    (body.provider === "lemon_squeezy" || body.provider === "whop") &&
    (body.providerEventId === null || typeof body.providerEventId === "string") &&
    (body.providerUpdatedAt === null || typeof body.providerUpdatedAt === "string");
}

/** Lease and retry committed dunning intents. A stable workflow ID makes an ambiguous Queue send
 * safe to replay; the Workflows consumer confirms an existing instance before acking redelivery. */
export async function dispatchDunningOutbox(env: DunningOutboxEnv, now = new Date(), limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("billing_dunning_outbox_limit_invalid");
  const at = now.toISOString();
  const leaseUntil = new Date(now.getTime() + 60_000).toISOString();
  const claimed = await env.PLATFORM_DB.prepare(`UPDATE billing_dunning_outbox SET status='leased',lease_until=?,
      attempt_count=attempt_count+1,updated_at=? WHERE workflow_id IN (
        SELECT workflow_id FROM billing_dunning_outbox WHERE
          (status='pending' AND next_attempt_at<=?) OR (status='leased' AND lease_until<=?)
        ORDER BY next_attempt_at,created_at,workflow_id LIMIT ?
      ) AND ((status='pending' AND next_attempt_at<=?) OR (status='leased' AND lease_until<=?))
      RETURNING workflow_id,tenant_id,payload_json,attempt_count`)
    .bind(leaseUntil, at, at, at, limit, at, at).all<DunningOutboxRow>();

  let sent = 0;
  let deferred = 0;
  for (const row of claimed.results ?? []) {
    try {
      const payload: unknown = JSON.parse(row.payload_json);
      if (!validDunningPayload(payload, row)) throw new Error("billing_dunning_payload_invalid");
      await env.DUNNING_EVENTS.send(payload);
      await env.PLATFORM_DB.prepare(`UPDATE billing_dunning_outbox SET status='sent',lease_until=NULL,sent_at=?,
        last_error=NULL,updated_at=? WHERE workflow_id=? AND status='leased' AND lease_until=?`)
        .bind(at, at, row.workflow_id, leaseUntil).run();
      sent++;
    } catch {
      const backoffSeconds = Math.min(6 * 60 * 60, 30 * 2 ** Math.min(10, Math.max(0, row.attempt_count - 1)));
      await env.PLATFORM_DB.prepare(`UPDATE billing_dunning_outbox SET status='pending',lease_until=NULL,
        next_attempt_at=?,last_error=?,updated_at=? WHERE workflow_id=? AND status='leased' AND lease_until=?`)
        .bind(new Date(now.getTime() + backoffSeconds * 1_000).toISOString(), "dispatch_failed", at, row.workflow_id, leaseUntil).run();
      deferred++;
    }
  }
  return { claimed: claimed.results?.length ?? 0, sent, deferred };
}
