// Webhook dispatcher (MS-34). Runs from the scheduled() handler every minute in every environment.
//
// 1. Fan-out: each pending nemail_events row is copied to one nemail_webhook_deliveries row per active webhook of the
//    same tenant that subscribes to its type. The event is marked dispatched in the same batch (idempotent via UNIQUE).
// 2. Attempts: due deliveries are leased (claimed_until), re-checked (webhook still active, destination still allowed,
//    deadline not passed), then POSTed with a 10 s timeout. 2xx = delivered. Anything else, or a timeout, schedules
//    the next attempt with backoff. When the next attempt would fall more than 24 h after the first attempt, the
//    delivery is dead-lettered.
//
// Delivery is at-least-once: a crash after a successful POST but before the outcome is written causes one repeat. The
// envelope id (also sent as Naelao-Event-Id) lets receivers deduplicate.
import { checkWebhookUrl } from "./ssrf.js";
import { decryptSecret, signPayload, webhookAad, webhookKeyUsable, SIGNATURE_HEADER } from "./webhooks.js";

export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] as const;
export const RETRY_WINDOW_MS = 24 * 3_600_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const LEASE_MS = 2 * 60_000;
export const EVENT_BATCH = 50;
export const DELIVERY_BATCH = 25;

/** Delay before the attempt that follows the `attemptsMade`-th failed attempt. */
export function retryDelayMs(attemptsMade: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attemptsMade, 1) - 1, RETRY_DELAYS_MS.length - 1)]!;
}

export interface DispatchEnv { PLATFORM_DB: D1Database; NEMAIL_WEBHOOK_KEY?: string }
export interface DispatchOptions { now?: Date; fetchImpl?: typeof fetch; eventBatch?: number; deliveryBatch?: number }
export interface DispatchResult { fannedOut: number; attempted: number }

interface EventRow { id: string; nemail_tenant_id: string; event_type: string; inbox_id: string; message_id: string | null; thread_id: string | null; delivery_id: string | null; created_at: string }
interface WebhookRow { id: string; url: string; event_types_json: string; secret_ciphertext: string | null; status: string; deleted_at: string | null; created_at: string }
interface DueRow { id: string; nemail_tenant_id: string; webhook_id: string; event_id: string; attempts: number; first_attempt_at: string | null }

const toIso = (sqlTime: string) => new Date(sqlTime.includes("T") ? sqlTime : `${sqlTime.replace(" ", "T")}Z`).toISOString();

export async function dispatchDue(env: DispatchEnv, opts: DispatchOptions = {}): Promise<DispatchResult> {
  const nowIso = (opts.now ?? new Date()).toISOString();
  const fannedOut = await fanOut(env.PLATFORM_DB, nowIso, opts.eventBatch ?? EVENT_BATCH);
  const attempted = await attemptDue(env, nowIso, opts.deliveryBatch ?? DELIVERY_BATCH, opts.fetchImpl ?? fetch);
  return { fannedOut, attempted };
}

/** Copies pending outbox events to matching webhooks. Returns the number of events processed. */
export async function fanOut(db: D1Database, nowIso: string, batch: number): Promise<number> {
  const events = await db.prepare(
    "SELECT id, nemail_tenant_id, event_type, inbox_id, message_id, thread_id, delivery_id, created_at FROM nemail_events WHERE dispatched_at IS NULL ORDER BY created_at, id LIMIT ?"
  ).bind(batch).all<EventRow>();
  for (const ev of events.results) {
    // Only webhooks that existed when the event was recorded are eligible; a deleted webhook is never selected.
    const hooks = await db.prepare(
      "SELECT id, event_types_json FROM nemail_webhooks WHERE nemail_tenant_id = ? AND status = 'active' AND deleted_at IS NULL AND created_at <= ? AND (inbox_id IS NULL OR inbox_id = ?)"
    ).bind(ev.nemail_tenant_id, ev.created_at, ev.inbox_id).all<WebhookRow>();
    const stmts: D1PreparedStatement[] = [];
    for (const hook of hooks.results) {
      let types: unknown[] = [];
      try { types = JSON.parse(hook.event_types_json) as unknown[]; } catch { types = []; }
      if (!types.includes(ev.event_type)) continue;
      stmts.push(db.prepare(
        "INSERT OR IGNORE INTO nemail_webhook_deliveries(id, nemail_tenant_id, webhook_id, event_id, status, attempts, next_attempt_at) VALUES(?,?,?,?, 'pending', 0, ?)"
      ).bind(`whd_${crypto.randomUUID()}`, ev.nemail_tenant_id, hook.id, ev.id, nowIso));
    }
    stmts.push(db.prepare("UPDATE nemail_events SET dispatched_at = ? WHERE id = ? AND dispatched_at IS NULL").bind(nowIso, ev.id));
    await db.batch(stmts);
  }
  return events.results.length;
}

async function attemptDue(env: DispatchEnv, nowIso: string, batch: number, fetchImpl: typeof fetch): Promise<number> {
  // Without the signing key nothing can be signed: pause rather than burn retries or dead-letter every webhook.
  if (!webhookKeyUsable(env.NEMAIL_WEBHOOK_KEY)) return 0;
  const due = await env.PLATFORM_DB.prepare(
    "SELECT id, nemail_tenant_id, webhook_id, event_id, attempts, first_attempt_at FROM nemail_webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? AND (claimed_until IS NULL OR claimed_until < ?) ORDER BY next_attempt_at, id LIMIT ?"
  ).bind(nowIso, nowIso, batch).all<DueRow>();
  await Promise.all(due.results.map(d => attemptOne(env, d, nowIso, fetchImpl)));
  return due.results.length;
}

async function finish(db: D1Database, id: string, status: "delivered" | "dead_letter" | "cancelled", nowIso: string, error: string | null, extra: { attempts?: number; firstAttemptAt?: string | null; statusCode?: number | null; deliveredAt?: string | null } = {}) {
  await db.prepare(
    "UPDATE nemail_webhook_deliveries SET status = ?, claimed_until = NULL, last_error = ?, attempts = COALESCE(?, attempts), first_attempt_at = COALESCE(first_attempt_at, ?), last_status_code = COALESCE(?, last_status_code), delivered_at = COALESCE(?, delivered_at), updated_at = ? WHERE id = ?"
  ).bind(status, error, extra.attempts ?? null, extra.firstAttemptAt ?? null, extra.statusCode ?? null, extra.deliveredAt ?? null, nowIso, id).run();
}

async function attemptOne(env: DispatchEnv, d: DueRow, nowIso: string, fetchImpl: typeof fetch): Promise<void> {
  const db = env.PLATFORM_DB;
  const now = Date.parse(nowIso);
  // Lease first: an overlapping run that loses the claim does nothing.
  const leaseUntil = new Date(now + LEASE_MS).toISOString();
  const claim = await db.prepare("UPDATE nemail_webhook_deliveries SET claimed_until = ? WHERE id = ? AND status = 'pending' AND (claimed_until IS NULL OR claimed_until < ?)")
    .bind(leaseUntil, d.id, nowIso).run();
  if (!((claim.meta?.changes ?? 0) > 0)) return;

  const hook = await db.prepare("SELECT id, url, event_types_json, secret_ciphertext, status, deleted_at, created_at FROM nemail_webhooks WHERE id = ? AND nemail_tenant_id = ?")
    .bind(d.webhook_id, d.nemail_tenant_id).first<WebhookRow>();
  if (!hook || hook.deleted_at || hook.status !== "active") return finish(db, d.id, "cancelled", nowIso, "webhook_inactive");

  const firstMs = d.first_attempt_at ? Date.parse(d.first_attempt_at) : now;
  if (now > firstMs + RETRY_WINDOW_MS) return finish(db, d.id, "dead_letter", nowIso, "retry_window_elapsed");

  // Checked again before every delivery: a stored URL that is no longer allowed is never contacted.
  const dest = checkWebhookUrl(hook.url);
  if (!dest.ok) return finish(db, d.id, "dead_letter", nowIso, "destination_refused");

  const secret = await decryptSecret(env.NEMAIL_WEBHOOK_KEY ?? "", hook.secret_ciphertext, webhookAad(d.nemail_tenant_id, hook.id));
  if (!secret) return finish(db, d.id, "dead_letter", nowIso, "secret_unreadable");

  const envelope = await buildEnvelope(db, d.event_id, d.nemail_tenant_id);
  if (!envelope) return finish(db, d.id, "cancelled", nowIso, "event_missing");
  const body = JSON.stringify(envelope);
  const timestamp = Math.floor(now / 1000);
  const signature = await signPayload(secret, timestamp, body);

  let statusCode: number | null = null, errorCode: string | null = null;
  try {
    const res = await fetchImpl(dest.href, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature, "naelao-event-id": envelope.id },
      body,
    });
    statusCode = res.status;
    if (!res.ok) errorCode = `http_${res.status}`;
    await res.body?.cancel().catch(() => {});
  } catch (e) {
    errorCode = (e as { name?: string }).name === "TimeoutError" || (e as { name?: string }).name === "AbortError" ? "timeout" : "network_error";
  }

  const attemptNo = d.attempts + 1;
  const attemptedAt = new Date(now).toISOString();
  await db.prepare("INSERT INTO nemail_webhook_attempts(id, nemail_tenant_id, delivery_id, attempt_no, attempted_at, status_code, error_code) VALUES(?,?,?,?,?,?,?)")
    .bind(`wha_${crypto.randomUUID()}`, d.nemail_tenant_id, d.id, attemptNo, attemptedAt, statusCode, errorCode).run();

  if (!errorCode) {
    return finish(db, d.id, "delivered", attemptedAt, null, { attempts: attemptNo, firstAttemptAt: attemptedAt, statusCode, deliveredAt: attemptedAt });
  }
  const nextMs = now + retryDelayMs(attemptNo);
  const deadlineMs = (d.first_attempt_at ? firstMs : now) + RETRY_WINDOW_MS;
  if (nextMs > deadlineMs) {
    return finish(db, d.id, "dead_letter", attemptedAt, errorCode, { attempts: attemptNo, firstAttemptAt: attemptedAt, statusCode });
  }
  await db.prepare("UPDATE nemail_webhook_deliveries SET attempts = ?, first_attempt_at = COALESCE(first_attempt_at, ?), next_attempt_at = ?, claimed_until = NULL, last_status_code = ?, last_error = ?, updated_at = ? WHERE id = ?")
    .bind(attemptNo, attemptedAt, new Date(nextMs).toISOString(), statusCode, errorCode, attemptedAt, d.id).run();
}

/** References only: ids, the recipient for delivery events, and the status implied by the event type. */
async function buildEnvelope(db: D1Database, eventId: string, tenantId: string) {
  const ev = await db.prepare("SELECT id, event_type, inbox_id, message_id, thread_id, delivery_id, created_at FROM nemail_events WHERE id = ? AND nemail_tenant_id = ?")
    .bind(eventId, tenantId).first<EventRow>();
  if (!ev) return null;
  const data: Record<string, unknown> = { message_id: ev.message_id, thread_id: ev.thread_id };
  if (ev.delivery_id) {
    const dlv = await db.prepare("SELECT recipient FROM nemail_deliveries WHERE id = ? AND nemail_tenant_id = ?").bind(ev.delivery_id, tenantId).first<{ recipient: string }>();
    data.delivery_id = ev.delivery_id;
    data.recipient = dlv?.recipient ?? null;
    data.status = ev.event_type.split(".").pop();
  }
  return { id: ev.id, type: ev.event_type, version: 1, tenant: tenantId, inbox_id: ev.inbox_id, occurred_at: toIso(ev.created_at), data };
}
