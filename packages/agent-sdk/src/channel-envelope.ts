/** Channel-agnostic message shape passed from verified adapters into the agent kernel. */
export interface NormalizedInboundMessage {
  channelId: string;
  sessionKey: string;
  sender: { id: string; name?: string; handle?: string };
  payload: {
    text: string;
    attachments: Array<{ type: "audio" | "image" | "video" | "document"; url: string; mimeType: string }>;
  };
  /** Whitelisted, non-secret provider metadata useful for dedupe and diagnostics. */
  rawMetadata: Record<string, unknown>;
}

export interface InboundEnvelopeInput {
  channel: string;
  senderId: string;
  text: string;
  externalId: string;
  timestamp: number;
  attachments?: NormalizedInboundMessage["payload"]["attachments"];
}

const MAX_ID_CHARS = 512;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/;

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS && !CONTROL_CHARS.test(value);
}

function normalizeAttachments(value: unknown): NormalizedInboundMessage["payload"]["attachments"] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new Error("invalid_normalized_inbound_message");
  return value.map((attachment) => {
    if (!attachment || typeof attachment !== "object") throw new Error("invalid_normalized_inbound_message");
    const candidate = attachment as Record<string, unknown>;
    if (!new Set(["audio", "image", "video", "document"]).has(candidate.type as string)
      || typeof candidate.url !== "string" || candidate.url.length > 2_048
      || typeof candidate.mimeType !== "string" || !MIME_TYPE.test(candidate.mimeType)) {
      throw new Error("invalid_normalized_inbound_message");
    }
    try {
      const url = new URL(candidate.url);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error();
    } catch { throw new Error("invalid_normalized_inbound_message"); }
    return { type: candidate.type as "audio" | "image" | "video" | "document", url: candidate.url, mimeType: candidate.mimeType };
  });
}

/** Build the shared envelope after signature verification and provider-specific parsing. */
export function toNormalizedInboundMessage(input: InboundEnvelopeInput): NormalizedInboundMessage {
  if (!input || typeof input !== "object" || typeof input.channel !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.channel)
    || !validOpaqueId(input.senderId) || !validOpaqueId(input.externalId)
    || typeof input.text !== "string" || input.text.length > MAX_TEXT_BYTES
    || new TextEncoder().encode(input.text).byteLength > MAX_TEXT_BYTES
    || !Number.isSafeInteger(input.timestamp) || input.timestamp < 0 || input.timestamp > 8_640_000_000_000_000) {
    throw new Error("invalid_normalized_inbound_message");
  }
  const attachments = normalizeAttachments(input.attachments);
  return {
    channelId: `ext_channel_${input.channel}`,
    sessionKey: `${input.channel}:${input.senderId}`,
    sender: { id: input.senderId },
    payload: { text: input.text, attachments },
    rawMetadata: { externalId: input.externalId, timestamp: input.timestamp },
  };
}
