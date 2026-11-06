import { validInboundWebhookUrl } from "./email.js";

const encoder = new TextEncoder();
function base64url(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
async function sign(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data))));
}
export async function eventWebhookSecret(master: string, tenantId: string, subscriptionId: string) {
  return sign(master, `agentport-event-webhook-v1\n${tenantId}\n${subscriptionId}`);
}
export async function eventWebhookSignature(secret: string, timestamp: string, body: string) {
  return `v1=${await sign(secret, `${timestamp}\n${body}`)}`;
}

/** Sends metadata-only wake signals. A 2xx acknowledges the notification, not the event: the
 * runtime still claims and acknowledges work through the normal AgentPort event API. */
export async function deliverEventNotifications(env: { PLATFORM_DB: D1Database; AGENTPORT_JWT_SECRET: string }, fetcher: typeof fetch = fetch) {
  if (!env.AGENTPORT_JWT_SECRET) throw new Error("event_webhook_secret_unavailable");
  const db = env.PLATFORM_DB, now = new Date().toISOString();
  // A successful HTTP response confirms receipt of the signal. Until the runtime claims the
  // event, periodically signal it again with the same delivery ID for receiver deduplication.
  await db.prepare(`UPDATE agentport_event_notifications SET status=CASE WHEN attempts>=8 THEN 'dead_letter' ELSE 'pending' END,updated_at=?
    WHERE status='sent' AND available_at<=? AND delivery_id IN (SELECT id FROM agentport_event_deliveries WHERE status='pending')`).bind(now, now).run();
  await db.prepare("UPDATE agentport_event_notifications SET status='dead_letter',lease_expires_at=NULL,updated_at=? WHERE status='sending' AND lease_expires_at<=? AND attempts>=8")
    .bind(now, now).run();
  await db.prepare(`UPDATE agentport_event_notifications SET status='pending',attempts=0,available_at=?,updated_at=? WHERE status IN ('sent','dead_letter')
    AND delivery_id IN (SELECT id FROM agentport_event_deliveries WHERE status='claimed' AND claim_expires_at<=? AND attempts<8)`)
    .bind(now, now, now).run();
  await db.prepare(`UPDATE agentport_event_deliveries SET status=CASE WHEN attempts>=8 THEN 'dead_letter' ELSE 'pending' END,
    claim_owner=NULL,claim_expires_at=NULL,updated_at=? WHERE status='claimed' AND claim_expires_at<=?`).bind(now, now).run();
  await db.prepare(`INSERT OR IGNORE INTO agentport_event_notifications(delivery_id,available_at,updated_at)
    SELECT d.id,d.available_at,? FROM agentport_event_deliveries d
    JOIN agentport_event_subscriptions s ON s.id=d.subscription_id AND s.tenant_id=d.tenant_id
    WHERE d.status='pending' AND s.status='active' AND s.delivery_mode='webhook'
      AND NOT EXISTS (SELECT 1 FROM agentport_event_notifications n WHERE n.delivery_id=d.id) LIMIT 500`).bind(now).run();
  const rows = await db.prepare(`SELECT n.delivery_id,d.tenant_id,d.subscription_id,d.agent_id,e.id AS event_id,e.service_id,e.account_id,e.event_type,e.thread_ref,e.payload_ref,s.routing_json
    FROM agentport_event_notifications n JOIN agentport_event_deliveries d ON d.id=n.delivery_id
    JOIN agentport_event_subscriptions s ON s.id=d.subscription_id AND s.tenant_id=d.tenant_id
    JOIN agentport_events e ON e.id=d.event_id AND e.tenant_id=d.tenant_id
    JOIN agentport_agents a ON a.id=d.agent_id AND a.tenant_id=d.tenant_id AND a.status='active'
    JOIN agentport_services p ON p.id=e.service_id AND p.tenant_id=e.tenant_id AND p.status='active'
    WHERE s.status='active' AND s.delivery_mode='webhook' AND d.status='pending' AND n.attempts<8
      AND ((n.status='pending' AND n.available_at<=?) OR (n.status='sending' AND n.lease_expires_at<=?))
      AND (e.account_id IS NULL OR EXISTS (SELECT 1 FROM agentport_accounts ac JOIN agentport_account_grants g ON g.account_id=ac.id AND g.tenant_id=ac.tenant_id
        WHERE ac.id=e.account_id AND ac.tenant_id=e.tenant_id AND ac.status='active' AND g.agent_id=d.agent_id AND g.status='active' AND (g.expires_at IS NULL OR g.expires_at>?)))
    ORDER BY n.available_at LIMIT 50`).bind(now, now, now).all<{
      delivery_id: string; tenant_id: string; subscription_id: string; agent_id: string; event_id: string; service_id: string;
      account_id: string | null; event_type: string; thread_ref: string | null; payload_ref: string | null; routing_json: string;
    }>();
  for (const row of rows.results ?? []) {
    const at = new Date().toISOString(), lease = new Date(Date.now() + 60_000).toISOString();
    const claim = await db.prepare(`UPDATE agentport_event_notifications SET status='sending',attempts=attempts+1,lease_expires_at=?,updated_at=?
      WHERE delivery_id=? AND attempts<8 AND ((status='pending' AND available_at<=?) OR (status='sending' AND lease_expires_at<=?))`)
      .bind(lease, at, row.delivery_id, at, at).run();
    if (!claim.meta.changes) continue;
    let success = false;
    try {
      const routing = JSON.parse(row.routing_json) as { webhookUrl?: unknown };
      if (typeof routing.webhookUrl !== "string" || !validInboundWebhookUrl(routing.webhookUrl)) throw new Error("invalid_webhook_url");
      const payload = JSON.stringify({ id: row.event_id, deliveryId: row.delivery_id, subscriptionId: row.subscription_id,
        agentId: row.agent_id, serviceId: row.service_id, accountId: row.account_id, type: row.event_type,
        threadRef: row.thread_ref, dataRef: row.payload_ref });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const secret = await eventWebhookSecret(env.AGENTPORT_JWT_SECRET, row.tenant_id, row.subscription_id);
      const response = await fetcher(routing.webhookUrl, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { "content-type": "application/json", "x-agentport-timestamp": timestamp,
          "x-agentport-signature": await eventWebhookSignature(secret, timestamp, payload) }, body: payload });
      success = response.ok;
      await response.body?.cancel().catch(() => {});
    } catch { /* The durable notification is retried with bounded backoff. */ }
    const next = new Date(Date.now() + 60_000 * 2 ** Math.min(6, Math.max(0, (await db.prepare("SELECT attempts FROM agentport_event_notifications WHERE delivery_id=?").bind(row.delivery_id).first<{ attempts: number }>())?.attempts ?? 1) - 1)).toISOString();
    await db.prepare(`UPDATE agentport_event_notifications SET status=CASE WHEN ? THEN 'sent' WHEN attempts>=8 THEN 'dead_letter' ELSE 'pending' END,
      available_at=?,lease_expires_at=NULL,updated_at=? WHERE delivery_id=? AND status='sending' AND lease_expires_at=?`)
      .bind(success ? 1 : 0, next, new Date().toISOString(), row.delivery_id, lease).run();
  }
}
