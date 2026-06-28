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

export interface ChannelAdapter {
  type: ChannelType;
  /** Normalize a raw channel payload; returns null if it isn't an actionable message. */
  normalizeInbound(raw: Record<string, unknown>): NormalizedInbound | null;
  /** Format an outbound message into the channel-native shape. */
  formatOutbound(msg: OutboundMessage): Record<string, unknown>;
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
