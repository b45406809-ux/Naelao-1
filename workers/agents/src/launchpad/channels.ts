/**
 * Channel adapters — the unified ingress/egress layer for Space Assistants.
 *
 * The spec's appendices flag (repeatedly) that channels were hand-coded per platform
 * with no shared contract:
 *   @4211129 — "No Channel Adapter Interface — Adding a New Channel Requires Hand-Coding"
 *   @4198622 — "No Channel Formatting Layer"
 *   @4200734 — "No Cross-Channel Identity Resolution"
 *   @3190360 — "Channel Hub Normalization Missing"
 *
 * This is the fix: one `ChannelAdapter` interface. Inbound payloads (raw, channel-
 * specific) are normalized to a single shape; outbound messages are formatted per
 * channel. Adding a channel = adding an adapter, not editing core logic.
 *
 * Pure and dependency-free so it is unit-testable.
 */

export type ChannelType = "email" | "slack" | "discord" | "whatsapp" | "telegram";

export interface NormalizedInbound {
  channel: ChannelType;
  /** The sender's id ON that channel — combined with channel for a per-user session. */
  channel_user_id: string;
  text: string;
  /** Channel-native id used to dedupe re-delivered events. */
  external_id: string;
  timestamp: number;
}

export interface OutboundMessage {
  text: string;
}

/** What a channel's webhook verifier needs — varies by channel (HMAC vs Ed25519 vs none). */
export interface SignatureInput {
  rawBody: string;
  headers: Record<string, string>;
  /** The space's per-channel signing secret (Slack signing secret / Discord public key / …). */
  secret: string;
}

export interface ChannelAdapter {
  type: ChannelType;
  /** Normalize a raw channel payload; returns null if it isn't an actionable message. */
  normalizeInbound(raw: Record<string, unknown>): NormalizedInbound | null;
  /** Format an outbound message into the channel-native shape. */
  formatOutbound(msg: OutboundMessage): Record<string, unknown>;
  /**
   * Verify an inbound webhook actually came from this channel before any normalization
   * happens (spec "Outbound Webhooks Not Verified by Default" — applies symmetrically to
   * inbound channel ingress). Fail-closed: any error during verification is "not verified."
   */
  verifySignature(input: SignatureInput): Promise<boolean>;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" ? v : undefined;
}

const emailAdapter: ChannelAdapter = {
  type: "email",
  normalizeInbound(raw) {
    const from = str(raw, "from");
    const text = str(raw, "text") ?? str(raw, "body");
    const id = str(raw, "message_id") ?? str(raw, "id");
    if (!from || !text || !id) return null;
    return { channel: "email", channel_user_id: from.toLowerCase(), text, external_id: id, timestamp: Date.now() };
  },
  formatOutbound(msg) {
    return { body: msg.text, content_type: "text/plain" };
  },
  // Mailgun-style inbound: HMAC-SHA256(timestamp + token, signing_key) — the shared scheme
  // for inbound-parse webhooks that support signing at all (most do, modeled on Mailgun's).
  // Reject requests older than 5 minutes to block replay (same window as Slack).
  async verifySignature({ headers, secret }) {
    const timestamp = headers["x-mailgun-timestamp"] ?? headers["x-timestamp"];
    const token = headers["x-mailgun-token"] ?? headers["x-token"];
    const signature = headers["x-mailgun-signature"] ?? headers["x-signature"];
    if (!timestamp || !token || !signature || !secret) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    try {
      const expected = await hmacSha256Hex(secret, `${timestamp}${token}`);
      return timingSafeEqual(expected, signature.toLowerCase());
    } catch {
      return false;
    }
  },
};

const slackAdapter: ChannelAdapter = {
  type: "slack",
  normalizeInbound(raw) {
    // Ignore bot echoes (Slack sets bot_id on its own messages).
    if (raw["bot_id"]) return null;
    const user = str(raw, "user");
    const text = str(raw, "text");
    const ts = str(raw, "ts");
    if (!user || !text || !ts) return null;
    return { channel: "slack", channel_user_id: user, text, external_id: ts, timestamp: Math.floor(Number(ts) * 1000) || Date.now() };
  },
  formatOutbound(msg) {
    return { text: msg.text, blocks: [{ type: "section", text: { type: "mrkdwn", text: msg.text } }] };
  },
  // Slack signing: HMAC-SHA256("v0:{timestamp}:{rawBody}", signing_secret) vs X-Slack-Signature
  // (prefixed "v0="). Reject requests older than 5 minutes to block replay.
  async verifySignature({ rawBody, headers, secret }) {
    const timestamp = headers["x-slack-request-timestamp"];
    const signature = headers["x-slack-signature"];
    if (!timestamp || !signature || !secret) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    try {
      const expected = `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${rawBody}`)}`;
      return timingSafeEqual(expected, signature);
    } catch {
      return false;
    }
  },
};

const discordAdapter: ChannelAdapter = {
  type: "discord",
  normalizeInbound(raw) {
    const author = raw["author"] as Record<string, unknown> | undefined;
    if (author?.["bot"]) return null;
    const userId = author ? str(author, "id") : undefined;
    const text = str(raw, "content");
    const id = str(raw, "id");
    if (!userId || !text || !id) return null;
    return { channel: "discord", channel_user_id: userId, text, external_id: id, timestamp: Date.now() };
  },
  formatOutbound(msg) {
    return { content: msg.text };
  },
  // Discord signing: Ed25519 over (timestamp + rawBody) vs X-Signature-Ed25519, verified
  // against the application's public key (hex). `secret` here IS the public key, not a
  // shared HMAC secret — Discord's scheme is asymmetric. Reject requests older than 5
  // minutes to block replay (same window as Slack).
  async verifySignature({ rawBody, headers, secret }) {
    const signature = headers["x-signature-ed25519"];
    const timestamp = headers["x-signature-timestamp"];
    if (!signature || !timestamp || !secret) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        hexToBytes(secret),
        { name: "Ed25519" },
        false,
        ["verify"]
      );
      return await crypto.subtle.verify(
        "Ed25519",
        key,
        hexToBytes(signature),
        new TextEncoder().encode(timestamp + rawBody)
      );
    } catch {
      return false;
    }
  },
};

// WhatsApp's Cloud API has no request-level timestamp header — the only timestamp is inside
// the message payload itself (entry[0].changes[0].value.messages[0].timestamp, epoch seconds).
// That field is covered by the X-Hub-Signature-256 HMAC (which signs the whole raw body), so an
// attacker can't forge a fresher timestamp without the app secret. Returns undefined for a
// status-callback payload (no `messages` array) — those have nothing to freshness-check and
// stay valid on signature alone, same as before this change.
function extractWhatsAppMessageTimestamp(rawBody: string): number | undefined {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const entry = (parsed["entry"] as Array<Record<string, unknown>> | undefined)?.[0];
    const change = (entry?.["changes"] as Array<Record<string, unknown>> | undefined)?.[0];
    const value = change?.["value"] as Record<string, unknown> | undefined;
    const message = (value?.["messages"] as Array<Record<string, unknown>> | undefined)?.[0];
    const ts = message ? str(message, "timestamp") : undefined;
    return ts ? Number(ts) : undefined;
  } catch {
    return undefined;
  }
}

// WhatsApp Business (Meta Cloud API) — the customer-facing business-number bot use case.
// Inbound webhook shape: entry[0].changes[0].value.messages[0] (delivery-receipt "statuses"
// callbacks have no `messages` array and are correctly ignored). Outbound goes through the
// Cloud API's /messages endpoint (handled by the notifications dispatch layer, not here).
const whatsappAdapter: ChannelAdapter = {
  type: "whatsapp",
  normalizeInbound(raw) {
    const entry = (raw["entry"] as Array<Record<string, unknown>> | undefined)?.[0];
    const change = (entry?.["changes"] as Array<Record<string, unknown>> | undefined)?.[0];
    const value = change?.["value"] as Record<string, unknown> | undefined;
    const message = (value?.["messages"] as Array<Record<string, unknown>> | undefined)?.[0];
    if (!message) return null; // status callback (sent/delivered/read) or malformed — not actionable

    const from = str(message, "from");
    const id = str(message, "id");
    const textBody = (message["text"] as Record<string, unknown> | undefined)?.["body"];
    const text = typeof textBody === "string" ? textBody : undefined;
    if (!from || !id || !text) return null; // non-text message (image/audio/...) — not handled yet

    const ts = str(message, "timestamp");
    return { channel: "whatsapp", channel_user_id: from, text, external_id: id, timestamp: ts ? Number(ts) * 1000 : Date.now() };
  },
  formatOutbound(msg) {
    return { messaging_product: "whatsapp", type: "text", text: { body: msg.text } };
  },
  // Meta Cloud API signing: HMAC-SHA256(rawBody, app_secret) vs X-Hub-Signature-256
  // (prefixed "sha256="). `secret` here is the WhatsApp app's App Secret. Reject a message
  // (not a status callback — see extractWhatsAppMessageTimestamp) older than 5 minutes, using
  // its own embedded timestamp since Meta sends no request-level one.
  async verifySignature({ rawBody, headers, secret }) {
    const header = headers["x-hub-signature-256"];
    if (!header?.startsWith("sha256=") || !secret) return false;
    const msgTimestamp = extractWhatsAppMessageTimestamp(rawBody);
    if (msgTimestamp !== undefined && Math.abs(Date.now() / 1000 - msgTimestamp) > 300) return false;
    try {
      const expected = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
      return timingSafeEqual(expected, header);
    } catch {
      return false;
    }
  },
};


/**
 * Telegram — the channel a business with no money can actually start on.
 *
 * Deliberately added ahead of Signal/iMessage (which OpenClaw also ships): those need a real phone
 * number bound to a long-running local process, which is exactly the single-operator assumption a
 * multi-tenant platform can't make. Telegram is a plain HTTPS webhook, free, with no per-message
 * billing, no business verification and no 24-hour reply window — the opposite of WhatsApp on
 * every axis that matters to a $0-budget business.
 *
 * Auth is different from every other adapter here and worth being explicit about: Telegram does
 * not sign its payloads. What it offers instead is a secret token the bot owner chooses when
 * registering the webhook, echoed back on every request in X-Telegram-Bot-Api-Secret-Token. So the
 * `secret` stored for this channel is that token, compared in constant time — it is a shared
 * bearer secret, not a signature over the body, and anyone who learns it can forge messages. That
 * is Telegram's own design, not a shortcut taken here.
 */
const telegramAdapter: ChannelAdapter = {
  type: "telegram",
  normalizeInbound(raw) {
    // An update carries exactly one of many possible payloads. Only real text messages are
    // actionable — edits, joins, polls and callback queries are not something to answer.
    const message = raw["message"] as Record<string, unknown> | undefined;
    if (!message) return null;
    const text = typeof message["text"] === "string" ? message["text"] : "";
    if (!text.trim()) return null;

    const from = message["from"] as Record<string, unknown> | undefined;
    const chat = message["chat"] as Record<string, unknown> | undefined;
    // Prefer the CHAT id, not the user id: it is what a reply has to be addressed to, and in a
    // group the two differ. Falling back to the sender keeps a malformed update from being
    // silently dropped.
    const conversationId = chat?.["id"] ?? from?.["id"];
    if (conversationId === undefined || conversationId === null) return null;

    const messageId = message["message_id"];
    const date = message["date"];
    return {
      channel: "telegram",
      channel_user_id: String(conversationId),
      text,
      // message_id is only unique per chat, so the dedupe key has to carry both.
      external_id: `${String(conversationId)}:${String(messageId ?? "")}`,
      timestamp: typeof date === "number" ? date * 1000 : Date.now(),
    };
  },
  formatOutbound(msg) {
    return { text: msg.text };
  },
  async verifySignature({ headers, secret }) {
    if (!secret) return false;
    const provided = headers["x-telegram-bot-api-secret-token"];
    if (!provided) return false;
    return timingSafeEqual(provided, secret);
  },
};

const ADAPTERS: Record<ChannelType, ChannelAdapter> = {
  email: emailAdapter,
  slack: slackAdapter,
  discord: discordAdapter,
  whatsapp: whatsappAdapter,
  telegram: telegramAdapter,
};

export function getAdapter(type: string): ChannelAdapter | undefined {
  return (ADAPTERS as Record<string, ChannelAdapter>)[type];
}

export function isChannelType(t: string): t is ChannelType {
  return t === "email" || t === "slack" || t === "discord" || t === "whatsapp" || t === "telegram";
}

/**
 * Per-user session key (appendix @3245389 / @2908507 / @1995937: sessions keyed by
 * channel TYPE only made all Slack users share one session — cross-user data bleed).
 * The key MUST include the channel-specific user id.
 */
export function sessionKey(channel: ChannelType, channelUserId: string): string {
  return `${channel}:${channelUserId}`;
}
