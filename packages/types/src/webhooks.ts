export type WebhookStatus = "ACTIVE" | "PAUSED" | "DELETED";

export type WebhookProviderType = "stripe" | "github" | "shopify" | "svix" | "generic_hmac";

export interface WebhookRegistrationRecord {
  spaceId: string;
  projectId: string;
  triggerSlug: string;
  workflowId: string;
  status: WebhookStatus;
  provider: WebhookProviderType;
  secretKey: string;
  rateLimitPerMinute?: number;
  createdAt: string;
  updatedAt: string;
}

export interface InboundWebhookEnvelope {
  eventId: string;
  spaceId: string;
  projectId: string;
  triggerSlug: string;
  workflowId: string;
  provider: WebhookProviderType;
  signature: string;
  headers: Record<string, string>;
  payload: Record<string, any>;
  rawBodyR2Key: string;
  receivedAt: string;
  attemptCount: number;
}

export interface WebhookReplayRequest {
  eventId: string;
  targetWorkflowId?: string;
  overridePayload?: Record<string, any>;
}
