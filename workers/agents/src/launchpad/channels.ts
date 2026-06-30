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

export type ChannelType = "email" | "slack" | "discord";

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
  async verifySignature({ headers, secret }) {
    const timestamp = headers["x-mailgun-timestamp"] ?? headers["x-timestamp"];
    const token = headers["x-mailgun-token"] ?? headers["x-token"];
    const signature = headers["x-mailgun-signature"] ?? headers["x-signature"];
    if (!timestamp || !token || !signature || !secret) return false;
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
  // shared HMAC secret — Discord's scheme is asymmetric.
  async verifySignature({ rawBody, headers, secret }) {
    const signature = headers["x-signature-ed25519"];
    const timestamp = headers["x-signature-timestamp"];
    if (!signature || !timestamp || !secret) return false;
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

const ADAPTERS: Record<ChannelType, ChannelAdapter> = {
  email: emailAdapter,
  slack: slackAdapter,
  discord: discordAdapter,
};

export function getAdapter(type: string): ChannelAdapter | undefined {
  return (ADAPTERS as Record<string, ChannelAdapter>)[type];
}

export function isChannelType(t: string): t is ChannelType {
  return t === "email" || t === "slack" || t === "discord";
}

/**
 * Per-user session key (appendix @3245389 / @2908507 / @1995937: sessions keyed by
 * channel TYPE only made all Slack users share one session — cross-user data bleed).
 * The key MUST include the channel-specific user id.
 */
export function sessionKey(channel: ChannelType, channelUserId: string): string {
  return `${channel}:${channelUserId}`;
}
