/**
 * AgentMail — a Naelao-provisioned, INBOUND-CAPABLE business mailbox (the piece the prior pass
 * deferred because this account owns zero DNS zones). AgentMail hosts the receiving domain itself:
 * `POST /v0/inboxes` with a username gives a real address that can both send AND receive on their
 * domain, so no Naelao-owned DNS zone is needed at all — which is exactly why it unblocks the
 * "auto-provisioned business email" feature.
 *
 * This is a dependency-free REST client verified against AgentMail's own OpenAPI
 * (https://docs.agentmail.to/openapi.json — base https://api.agentmail.to, Bearer auth, paths
 * under /v0). Every function degrades HONESTLY when `AGENTMAIL_API_KEY` is unset
 * (`{configured:false}`) rather than throwing or pretending — the same "confirm once real access
 * exists" precedent as this repo's Whop/Composio integrations. The exact wire shapes
 * below are the real ones from the OpenAPI, not guessed; the one thing genuinely unverified until
 * a live key exists is the Svix header/secret format (documented on the verify function).
 */

const AGENTMAIL_BASE = "https://api.agentmail.to";

export interface AgentMailEnv {
  /** AgentMail API key (Bearer). A Workers Secret — never in code/wrangler vars. Unset = the whole
   *  integration degrades honestly to "not configured" and the caller falls back (Resend for send,
   *  no inbound). */
  AGENTMAIL_API_KEY?: string;
  /** Public base URL of this agents worker (already used for the OAuth callback) — the inbound
   *  webhook is registered as `${PUBLIC_AGENTS_URL}/channels/email/agentmail-inbound/{spaceId}`. */
  PUBLIC_AGENTS_URL?: string;
}

export function agentMailConfigured(env: AgentMailEnv): boolean {
  return Boolean(env.AGENTMAIL_API_KEY);
}

async function amFetch(
  env: AgentMailEnv,
  path: string,
  init: { method: string; body?: unknown }
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const resp = await fetch(`${AGENTMAIL_BASE}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${env.AGENTMAIL_API_KEY}`,
      "content-type": "application/json",
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const json = await resp.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  return { ok: resp.ok, status: resp.status, json };
}

/** A slug → an AgentMail-safe local part (their `username`). Bounded, lowercased, no leading/
 *  trailing separators — mirrors the storefront/handle slugging already used in spaces-worker. */
export function toInboxUsername(input: string): string {
  return (input || "team").toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40) || "team";
}

/**
 * `toInboxUsername` alone collides in production: AgentMail's `username` is unique across its
 * ENTIRE customer base, not scoped to our account — confirmed live provisioning the platform's own
 * "launchpad" business, which 403'd with `resource_taken` because some other AgentMail customer
 * already owns that exact username on their shared default domain. A common business name/slug is
 * genuinely likely to collide. Appends a short spaceId-derived suffix so a provisioned address is
 * virtually guaranteed unique while staying readable (`acme-corp-a1b2c3` rather than a bare UUID).
 */
export function uniqueInboxUsername(slug: string, spaceId: string): string {
  const suffix = (spaceId.replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase() || "000000");
  const base = toInboxUsername(slug).slice(0, Math.max(1, 39 - suffix.length - 1));
  return `${base}-${suffix}`;
}

export interface CreateInboxResult {
  ok: boolean;
  configured: boolean;
  /** The real, inbound-capable email address AgentMail allocated. */
  email?: string;
  inboxId?: string;
  error?: string;
}

/**
 * Create (or idempotently reuse) an inbox for a space. `client_id` is set to the spaceId — a
 * caller-supplied reference AgentMail stores, so a re-provision of the same space is safe to
 * attempt (we also short-circuit before calling this when a business_services row already exists).
 * `username` omitted lets AgentMail assign one on its default domain; passing one gives a readable
 * address. Response fields (`email`, `inbox_id`) are verified against the OpenAPI's create-inbox
 * 200 schema.
 */
export async function createInbox(
  env: AgentMailEnv,
  opts: { username?: string; displayName?: string; spaceId: string }
): Promise<CreateInboxResult> {
  if (!agentMailConfigured(env)) return { ok: false, configured: false };
  try {
    const res = await amFetch(env, "/v0/inboxes", {
      method: "POST",
      body: {
        ...(opts.username ? { username: opts.username } : {}),
        ...(opts.displayName ? { display_name: opts.displayName } : {}),
        client_id: opts.spaceId,
      },
    });
    if (!res.ok) {
      return { ok: false, configured: true, error: `agentmail create inbox failed (${res.status}): ${JSON.stringify(res.json).slice(0, 200)}` };
    }
    const email = typeof res.json["email"] === "string" ? (res.json["email"] as string) : undefined;
    const inboxId = typeof res.json["inbox_id"] === "string" ? (res.json["inbox_id"] as string) : undefined;
    if (!email || !inboxId) return { ok: false, configured: true, error: "agentmail response missing email/inbox_id" };
    return { ok: true, configured: true, email, inboxId };
  } catch (err) {
    return { ok: false, configured: true, error: `agentmail create inbox error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface CreateWebhookResult {
  ok: boolean;
  configured: boolean;
  webhookId?: string;
  /** Svix signing secret for verifying inbound webhook deliveries. Returned once at creation. */
  secret?: string;
  error?: string;
}

/** Register an inbound webhook on an inbox for `message.received` events, pointing at our public
 *  Svix-verified ingress. Body/response fields verified against the OpenAPI create-webhook schema
 *  (`url`, `event_types`, response `webhook_id`/`secret`). */
export async function createInboundWebhook(
  env: AgentMailEnv,
  inboxId: string,
  webhookUrl: string
): Promise<CreateWebhookResult> {
  if (!agentMailConfigured(env)) return { ok: false, configured: false };
  try {
    const res = await amFetch(env, `/v0/inboxes/${encodeURIComponent(inboxId)}/webhooks`, {
      method: "POST",
      body: { url: webhookUrl, event_types: ["message.received"] },
    });
    if (!res.ok) {
      return { ok: false, configured: true, error: `agentmail create webhook failed (${res.status}): ${JSON.stringify(res.json).slice(0, 200)}` };
    }
    const webhookId = typeof res.json["webhook_id"] === "string" ? (res.json["webhook_id"] as string) : undefined;
    const secret = typeof res.json["secret"] === "string" ? (res.json["secret"] as string) : undefined;
    return { ok: true, configured: true, ...(webhookId ? { webhookId } : {}), ...(secret ? { secret } : {}) };
  } catch (err) {
    return { ok: false, configured: true, error: `agentmail create webhook error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface SendResult {
  ok: boolean;
  configured: boolean;
  messageId?: string;
  threadId?: string;
  error?: string;
}

/** Send from a provisioned inbox. `to` accepts a single address or a list (AgentMail's `Addresses`
 *  oneOf). Response fields verified against the OpenAPI send 200 schema (`message_id`/`thread_id`). */
export async function sendFromInbox(
  env: AgentMailEnv,
  inboxId: string,
  msg: { to: string | string[]; subject?: string; text?: string; html?: string }
): Promise<SendResult> {
  if (!agentMailConfigured(env)) return { ok: false, configured: false };
  if (!msg.to || (Array.isArray(msg.to) && msg.to.length === 0)) return { ok: false, configured: true, error: "recipient 'to' is required" };
  try {
    const res = await amFetch(env, `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/send`, {
      method: "POST",
      body: {
        to: msg.to,
        ...(msg.subject ? { subject: msg.subject } : {}),
        ...(msg.text ? { text: msg.text } : {}),
        ...(msg.html ? { html: msg.html } : {}),
      },
    });
    if (!res.ok) {
      return { ok: false, configured: true, error: `agentmail send failed (${res.status}): ${JSON.stringify(res.json).slice(0, 200)}` };
    }
    return {
      ok: true, configured: true,
      ...(typeof res.json["message_id"] === "string" ? { messageId: res.json["message_id"] as string } : {}),
      ...(typeof res.json["thread_id"] === "string" ? { threadId: res.json["thread_id"] as string } : {}),
    };
  } catch (err) {
    return { ok: false, configured: true, error: `agentmail send error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Inbound: Svix signature verification + payload parse ──────────────────────

/**
 * Verify an AgentMail (Svix-delivered) inbound webhook signature.
 *
 * AgentMail signs webhooks with Svix, whose scheme is stable and public:
 *   - headers: `svix-id`, `svix-timestamp`, `svix-signature`
 *   - the signing secret is `whsec_<base64>`; the bytes after the prefix are base64-decoded
 *   - signed content = `${svix-id}.${svix-timestamp}.${rawBody}`
 *   - expected = base64( HMAC-SHA256(secretBytes, signedContent) )
 *   - the `svix-signature` header is a space-delimited list of `v1,<sig>` — a match against ANY
 *     entry is valid (Svix rotates secrets by sending multiple)
 *   - deliveries older than 5 minutes are rejected (replay protection), same window as the
 *     Slack/Mailgun adapters in channels.ts.
 *
 * The Svix scheme itself is verified against Svix's published spec; what remains genuinely
 * unconfirmed until a live AgentMail webhook fires is only that AgentMail uses these exact header
 * names (it advertises Svix, and the OpenAPI names `SvixId`/`SvixSignature`/`SvixTimestamp` schemas
 * — strong evidence, not a live observation). Fails CLOSED on any parsing/crypto error.
 */
export async function verifySvixSignature(opts: {
  headers: Record<string, string>;
  rawBody: string;
  secret: string;
  nowMs?: number;
}): Promise<boolean> {
  const { headers, rawBody, secret } = opts;
  const svixId = headers["svix-id"] ?? headers["webhook-id"];
  const svixTimestamp = headers["svix-timestamp"] ?? headers["webhook-timestamp"];
  const svixSignature = headers["svix-signature"] ?? headers["webhook-signature"];
  if (!svixId || !svixTimestamp || !svixSignature || !secret) return false;

  const now = opts.nowMs ?? Date.now();
  const tsSec = Number(svixTimestamp);
  if (!Number.isFinite(tsSec) || Math.abs(now / 1000 - tsSec) > 300) return false;

  try {
    const secretB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
    const keyBytes = base64ToBytes(secretB64);
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
    const expected = bytesToBase64(new Uint8Array(sig));
    // Header is space-delimited "v1,<sig> v1,<sig2>" — accept a match against any version-1 entry.
    for (const part of svixSignature.split(" ")) {
      const [, sigVal] = part.split(",");
      if (sigVal && timingSafeEqualStr(sigVal, expected)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Normalized inbound email, ready to hand to the same channel pipeline every other channel uses
 *  (`emailAdapter.normalizeInbound`'s output shape: from / text / external_id). */
export interface ParsedInboundEmail {
  from: string;
  text: string;
  messageId: string;
  subject?: string;
}

/**
 * Parse an AgentMail `message.received` webhook body into the fields the channel pipeline needs.
 * Shape verified against the OpenAPI `MessageReceivedEvent` schema: `{type:"event",
 * event_type:"message.received"|..., event_id, message:{from, to, subject, text, ...}, thread}`.
 * Returns null for a non-message event or a message with no usable sender/body — the caller
 * ack-ignores, never 500s (an unparseable delivery must not look like a server failure to Svix,
 * which would retry it forever).
 */
export function parseInboundMessageReceived(payload: unknown): ParsedInboundEmail | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const eventType = typeof p["event_type"] === "string" ? (p["event_type"] as string) : "";
  if (!eventType.startsWith("message.received")) return null;
  // Spam/blocked/unauthenticated variants share the prefix — a spam-flagged inbound is a real
  // signal a human may want, but it must never auto-drive the agent; the caller decides. Here we
  // only surface the ordinary `message.received`; the flagged variants are returned as null so
  // they don't feed the reasoning loop (the inbound route logs them separately).
  if (eventType !== "message.received") return null;

  const message = p["message"];
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  const from = typeof m["from"] === "string" ? (m["from"] as string) : "";
  const text = typeof m["text"] === "string" ? (m["text"] as string)
    : typeof m["preview"] === "string" ? (m["preview"] as string) : "";
  const messageId = typeof m["message_id"] === "string" ? (m["message_id"] as string) : "";
  const subject = typeof m["subject"] === "string" ? (m["subject"] as string) : undefined;
  if (!from || !text || !messageId) return null;
  return { from, text, messageId, ...(subject ? { subject } : {}) };
}

// ── small crypto/encoding helpers (no deps) ──────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** Constant-time-ish string compare (length-independent short-circuit avoided). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
