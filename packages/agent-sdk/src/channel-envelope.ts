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

/** Build the shared envelope after signature verification and provider-specific parsing. */
export function toNormalizedInboundMessage(input: InboundEnvelopeInput): NormalizedInboundMessage {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.channel) || !input.senderId || !input.externalId
    || typeof input.text !== "string" || !Number.isFinite(input.timestamp)) {
    throw new Error("invalid_normalized_inbound_message");
  }
  return {
    channelId: `ext_channel_${input.channel}`,
    sessionKey: `${input.channel}:${input.senderId}`,
    sender: { id: input.senderId },
    payload: { text: input.text, attachments: input.attachments ?? [] },
    rawMetadata: { externalId: input.externalId, timestamp: input.timestamp },
  };
}
