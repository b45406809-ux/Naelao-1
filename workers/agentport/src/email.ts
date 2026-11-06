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
  const eventId = message.headers.get("message-id")?.slice(0, 512) || crypto.randomUUID();
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
