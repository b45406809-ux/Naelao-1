const encoder = new TextEncoder();
const MAX_INBOUND_EMAIL_BYTES = 20 * 1024 * 1024;

export function normalizedEmailDomain(value?: string) {
  const domain = value?.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!domain || domain.length > 253 || !domain.includes(".") || !/^[a-z0-9.-]+$/.test(domain) || domain.split(".").some(part => !part || part.length > 63 || part.startsWith("-") || part.endsWith("-"))) return null;
  return domain;
}

export function validEmailAddress(value: string) {
  return value.length <= 254 && /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(value);
}

export function validInboundWebhookUrl(value: string) {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && (!url.port || url.port === "443") &&
      !hostname.includes(":") && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) && hostname.includes(".") &&
      !["localhost", "local", "internal", "test", "invalid", "example"].some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`));
  } catch { return false; }
}

async function hmac(secret: string, data: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(data)));
}

function base64url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Per-mailbox key, derived so an authenticated owner can safely retry provisioning. */
export async function deriveEmailWebhookSecret(masterSecret: string, tenantId: string, accountId: string) {
  return base64url(await hmac(masterSecret, encoder.encode(`agentport-email-webhook-v1\n${tenantId}\n${accountId}`)));
}

export async function emailWebhookSignature(secret: string, timestamp: string, eventId: string, raw: Uint8Array) {
  const prefix = encoder.encode(`${timestamp}\n${eventId}\n`);
  const data = new Uint8Array(prefix.length + raw.length);
  data.set(prefix); data.set(raw, prefix.length);
  return `v1=${base64url(await hmac(secret, data))}`;
}

export interface AgentPortEmailEnv {
  PLATFORM_DB: D1Database;
  AGENTPORT_JWT_SECRET: string;
  EMAIL_INGRESS_DOMAIN?: string;
  EMAIL_PROVISIONING_ENABLED?: string;
  fetch?: typeof fetch;
}

export async function handleAgentPortEmail(message: ForwardableEmailMessage, env: AgentPortEmailEnv) {
  const domain = normalizedEmailDomain(env.EMAIL_INGRESS_DOMAIN);
  const address = message.to.trim().toLowerCase();
  if (env.EMAIL_PROVISIONING_ENABLED !== "true" || !domain || !validEmailAddress(address) || address.slice(address.lastIndexOf("@") + 1) !== domain) {
    message.setReject("AgentPort email domain is not configured for this address");
    return;
  }
  if (message.rawSize > MAX_INBOUND_EMAIL_BYTES) {
    message.setReject("Message exceeds AgentPort's inbound size limit");
    return;
  }
  const row = await env.PLATFORM_DB.prepare(`SELECT e.tenant_id,e.account_id,e.agent_id,e.inbound_webhook_url,a.status AS account_status,g.status AS agent_status
    FROM agentport_email_accounts e JOIN agentport_accounts a ON a.id=e.account_id AND a.tenant_id=e.tenant_id
    JOIN agentport_agents g ON g.id=e.agent_id AND g.tenant_id=e.tenant_id
    WHERE e.address=? AND e.status='active' LIMIT 1`).bind(address).first<{
      tenant_id: string; account_id: string; agent_id: string; inbound_webhook_url: string; account_status: string; agent_status: string;
    }>();
  if (!row || row.account_status !== "active" || row.agent_status !== "active") {
    message.setReject("AgentPort mailbox is unavailable");
    return;
  }
  if (!validInboundWebhookUrl(row.inbound_webhook_url)) {
    message.setReject("AgentPort mailbox webhook is unavailable");
    return;
  }
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  if (raw.byteLength > MAX_INBOUND_EMAIL_BYTES) {
    message.setReject("Message exceeds AgentPort's inbound size limit");
    return;
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const providerMessageId = (message.headers.get("message-id")?.replace(/^<|>$/g, "").slice(0, 512) || crypto.randomUUID());
  const eventId = providerMessageId;
  // Register only provider references and routing metadata in AgentPort. The raw message is
  // forwarded to the account owner's channel endpoint below and is never written to D1/R2.
  const serviceId = `ap_email:${row.tenant_id}`;
  const channel = await env.PLATFORM_DB.prepare("SELECT id FROM agentport_channels WHERE tenant_id=? AND service_id=? AND account_id=? AND status='active' LIMIT 1")
    .bind(row.tenant_id, serviceId, row.account_id).first<{ id: string }>();
  if (!channel) {
    message.setReject("AgentPort email channel is unavailable");
    return;
  }
  const occurredAt = message.headers.get("date") && Number.isFinite(Date.parse(message.headers.get("date")!))
    ? new Date(message.headers.get("date")!).toISOString() : new Date().toISOString();
  const threadRef = (message.headers.get("in-reply-to") ?? message.headers.get("references") ?? providerMessageId).replace(/[<>]/g, "").slice(0, 512);
  const now = new Date().toISOString();
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO agentport_threads(id,tenant_id,channel_id,provider_thread_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`).bind(`thr_${row.account_id}_${await shortHash(threadRef)}`, row.tenant_id, channel.id, threadRef, now, now).run();
  const thread = await env.PLATFORM_DB.prepare("SELECT id FROM agentport_threads WHERE tenant_id=? AND channel_id=? AND provider_thread_id=?")
    .bind(row.tenant_id, channel.id, threadRef).first<{ id: string }>();
  if (!thread) {
    message.setReject("AgentPort email event could not be recorded");
    return;
  }
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO agentport_channel_message_refs
    (id,tenant_id,channel_id,thread_id,provider_message_id,direction,sender_id,sender_role,trust_level,status,occurred_at,created_at)
    VALUES(?,?,?,?,?,'inbound',?,'external','unverified','received',?,?)`)
    .bind(`mref_${row.account_id}_${await shortHash(providerMessageId)}`, row.tenant_id, channel.id, thread.id, providerMessageId, message.from.slice(0, 512), occurredAt, now).run();
  await env.PLATFORM_DB.prepare("UPDATE agentport_threads SET last_message_at=?,updated_at=? WHERE id=? AND tenant_id=?")
    .bind(occurredAt, now, thread.id, row.tenant_id).run();
  const apEventId = `evt_${row.account_id}_${await shortHash(providerMessageId)}`;
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO agentport_events(id,tenant_id,service_id,account_id,provider_event_id,event_type,thread_ref,payload_ref,available_at,created_at)
    VALUES(?,?,?,?,?,'message.received',?,?,?,?)`).bind(apEventId, row.tenant_id, serviceId, row.account_id, providerMessageId, thread.id, providerMessageId, now, now).run();
  const subscriptions = await env.PLATFORM_DB.prepare(`SELECT id,agent_id FROM agentport_event_subscriptions WHERE tenant_id=? AND service_id=?
    AND event_type='message.received' AND status='active' AND (account_id IS NULL OR account_id=?)`).bind(row.tenant_id, serviceId, row.account_id).all<{ id: string; agent_id: string }>();
  for (const subscription of subscriptions.results ?? []) {
    await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO agentport_event_deliveries
      (id,tenant_id,event_id,subscription_id,agent_id,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(`dlv_${subscription.id}_${await shortHash(providerMessageId)}`, row.tenant_id, apEventId, subscription.id, subscription.agent_id, now, now, now).run();
  }
  const secret = await deriveEmailWebhookSecret(env.AGENTPORT_JWT_SECRET, row.tenant_id, row.account_id);
  const signature = await emailWebhookSignature(secret, timestamp, eventId, raw);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await (env.fetch ?? fetch)(row.inbound_webhook_url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: {
          "content-type": "message/rfc822", "cache-control": "no-store",
          "x-agentport-account-id": row.account_id, "x-agentport-agent-id": row.agent_id,
          "x-agentport-event-id": eventId, "x-agentport-timestamp": timestamp,
          "x-agentport-signature": signature,
        },
        body: raw,
      });
      if (response.ok) return;
      await response.body?.cancel().catch(() => {});
    } catch { /* Retry the idempotent delivery before rejecting the inbound message. */ }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 200 : 600));
  }
  message.setReject("AgentPort could not deliver this message to the mailbox owner");
}

async function shortHash(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
