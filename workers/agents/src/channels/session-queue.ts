export interface SessionQueueMessage {
  type: "inbound_channel";
  channel_type: string;
  space_id: string;
  tenant_id: string;
  project_id?: string;
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
export interface ProviderEventReferenceQueueMessage {
  type:"provider_event_reference";
  tenantId:string;
  spaceId:string;
  projectId?:string;
  agentId:string;
  connectionId:string;
  accountId:string;
  subscriptionId:string;
  eventId:string;
  deliveryId:string;
  serviceId:string;
  eventType:string;
  threadRef:string;
  dataRef:string;
}

export type ChannelSessionQueueMessage =
  | SessionQueueMessage
  | SpaceTriggerQueueMessage
  | ProviderEventReferenceQueueMessage;

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
      (value.project_id === undefined || (typeof value.project_id === "string" && value.project_id.length > 0 && value.project_id.length <= 160)) &&
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
  if(value.type==="provider_event_reference")return !["body","content","text","html","attachments","raw"].some(key=>key in value)&&["tenantId","spaceId","agentId","connectionId","accountId","subscriptionId","eventId","deliveryId","serviceId","eventType","threadRef","dataRef"].every(key=>typeof value[key]==="string"&&(value[key] as string).length>0&&(value[key] as string).length<=1024)&&(value.projectId===undefined||(typeof value.projectId==="string"&&value.projectId.length<=160));
  return false;
}

export async function handleChannelSessionQueue(
  messages: readonly QueueMessageLike[],
  deps: ChannelSessionQueueDeps
): Promise<void> {
  for (const message of messages) {
    if (!isChannelSessionQueueMessage(message.body)) {
      deps.logError(
        "[channel-sessions] invalid queue message — retrying to configured DLQ",
        new Error("invalid_message")
      );
      message.retry();
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
