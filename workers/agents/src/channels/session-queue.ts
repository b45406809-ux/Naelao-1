export interface SessionQueueMessage {
  type: "inbound_channel";
  channel_type: string;
  space_id: string;
  tenant_id: string;
  end_user_id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface SpaceTriggerQueueMessage {
  type: "space_trigger";
  spaceId: string;
  projectId: string;
  tenantId: string;
  message: string;
}

export type ChannelSessionQueueMessage =
  | SessionQueueMessage
  | SpaceTriggerQueueMessage;

export interface QueueMessageLike {
  id: string;
  body: unknown;
  ack(): void;
  retry(): void;
}

export interface ChannelSessionQueueDeps {
  process(
    message: ChannelSessionQueueMessage,
    queueMessageId: string
  ): Promise<void>;
  logError(message: string, error: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isChannelSessionQueueMessage(
  value: unknown
): value is ChannelSessionQueueMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "inbound_channel") {
    return (
      typeof value.channel_type === "string" &&
      value.channel_type.length <= 40 &&
      typeof value.space_id === "string" &&
      value.space_id.length > 0 &&
      value.space_id.length <= 160 &&
      typeof value.tenant_id === "string" &&
      value.tenant_id.length > 0 &&
      value.tenant_id.length <= 160 &&
      typeof value.end_user_id === "string" &&
      value.end_user_id.length > 0 &&
      value.end_user_id.length <= 320 &&
      typeof value.content === "string" &&
      new TextEncoder().encode(value.content).byteLength <= 100_000 &&
      isRecord(value.metadata) &&
      new TextEncoder().encode(JSON.stringify(value.metadata)).byteLength <=
        16_384
    );
  }
  if (value.type === "space_trigger") {
    return (
      typeof value.spaceId === "string" &&
      value.spaceId.length > 0 &&
      value.spaceId.length <= 160 &&
      typeof value.projectId === "string" &&
      value.projectId.length > 0 &&
      value.projectId.length <= 160 &&
      typeof value.tenantId === "string" &&
      value.tenantId.length > 0 &&
      value.tenantId.length <= 160 &&
      typeof value.message === "string" &&
      value.message.length > 0 &&
      value.message.length <= 10_000
    );
  }
  return false;
}

export async function handleChannelSessionQueue(
  messages: readonly QueueMessageLike[],
  deps: ChannelSessionQueueDeps
): Promise<void> {
  for (const message of messages) {
    if (!isChannelSessionQueueMessage(message.body)) {
      deps.logError(
        "[channel-sessions] invalid queue message",
        new Error("invalid_message")
      );
      message.ack();
      continue;
    }
    try {
      await deps.process(message.body, message.id);
      message.ack();
    } catch (error) {
      deps.logError(
        `[channel-sessions] dispatch failed type=${message.body.type}`,
        error
      );
      message.retry();
    }
  }
}
