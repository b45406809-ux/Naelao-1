// Naelao shared types — single source of truth for all workers

// ─── Identity & Auth ──────────────────────────────────────────────────────────

export type SpaceStatus = 'active' | 'suspended' | 'paused' | 'deleted';
export type MemberRole = 'owner' | 'admin' | 'member' | 'viewer';
export type BillingProviderName = 'lemon_squeezy' | 'stripe';

export interface JWTPayload {
  sub: string;
  spaceId: string;
  rootSpaceId: string;
  role: MemberRole;
  builderId: string;
  exp: number;
  iat?: number;
  impersonatedBy?: string;
  scope?: string[];
}

// ─── Agent Types ─────────────────────────────────────────────────────────────

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type FinishReason = 'stop' | 'tool_calls' | 'max_tokens' | 'error' | 'timeout' | 'cancelled';
export type ToolCallStatus = 'pending' | 'running' | 'complete' | 'failed' | 'timeout';
export type FiberStatus = 'idle' | 'running' | 'waiting_tool' | 'paused' | 'done' | 'error';

export interface AgentRun {
  id: string;
  agentId: string;
  spaceId: string;
  userId: string;
  status: AgentRunStatus;
  model: string;
  instructions: string;
  threadId?: string;
  startedAt: string;
  completedAt?: string;
  creditsCharged?: number;
  error?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ToolResult {
  callId: string;
  runId: string;
  output: unknown;
  error?: string;
}

export interface Message {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | ToolCall[];
  toolCallId?: string;
  createdAt: string;
  seq: number;
}

// ─── Space & Member Types ─────────────────────────────────────────────────────

export interface Space {
  id: string;
  rootSpaceId: string;
  name: string;
  slug: string;
  status: SpaceStatus;
  spaceType?: string;
  billingProvider?: BillingProviderName;
  billingSubscriptionId?: string;
  billingPortalUrl?: string;
  billingCustomerId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceMember {
  spaceId: string;
  userId: string;
  role: MemberRole;
  joinedAt: string;
}

export interface SpaceCreateParams {
  name: string;
  slug: string;
  spaceType?: string;
  metadata?: Record<string, unknown>;
}

export interface SpaceUpdateParams {
  name?: string;
  slug?: string;
  status?: SpaceStatus;
  metadata?: Record<string, unknown>;
}

// ─── Knowledge Types ──────────────────────────────────────────────────────────

export interface KnowledgeDoc {
  id: string;
  spaceId: string;
  projectId?: string;
  title: string;
  status: 'queued' | 'indexing' | 'ready' | 'failed';
  chunkCount?: number;
  errorMessage?: string;
  createdAt: string;
}

export interface KnowledgeChunk {
  id: string;
  docId: string;
  spaceId: string;
  chunkIndex: number;
  text: string;
  embedding?: number[];
}

// ─── Billing Types ────────────────────────────────────────────────────────────

export type NormalizedEventType =
  | 'payment.success'
  | 'payment.failed'
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.cancelled'
  | 'subscription.paused'
  | 'subscription.resumed'
  | 'refund.issued';

export interface NormalizedBillingEvent {
  type: NormalizedEventType;
  provider: BillingProviderName;
  spaceId: string;
  customerId: string;
  subscriptionId: string | null;
  variantOrPriceId: string;
  amountCents: number;
  currency: string;
  portalUrl?: string;
  rawEventId: string;
}

export interface CheckoutParams {
  spaceId: string;
  planVariantOrPriceId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
}

export interface LemonSqueezyOrderPayload {
  meta: {
    event_name: string;
    custom_data: { spaceId?: string };
  };
  data: {
    id: string;
    attributes: {
      identifier: string;
      status: string;
      total: string;
      currency: string;
      first_order_item: {
        variant_id: number;
        product_name: string;
      };
      customer_id: number;
      urls?: { customer_portal?: string };
      custom_data?: { spaceId?: string };
    };
  };
}

export interface LemonSqueezySubscriptionPayload {
  meta: {
    event_name: string;
    custom_data: { spaceId?: string };
  };
  data: {
    id: string;
    attributes: {
      status: string;
      customer_id: number;
      variant_id: number;
      first_subscription_item?: { variant_id: number };
      urls: { customer_portal: string };
      custom_data?: { spaceId?: string };
    };
  };
}

// ─── Common API Types ─────────────────────────────────────────────────────────

export type APIResponse<T> = { data: T } | APIError;

export interface APIError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function isAPIError(r: unknown): r is APIError {
  return (
    typeof r === 'object' &&
    r !== null &&
    'error' in r &&
    typeof (r as APIError).error === 'object'
  );
}

export function ok<T>(data: T): { data: T } {
  return { data };
}

export function err(
  code: string,
  message: string,
  details?: Record<string, unknown>
): APIError {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export type AnalyticsEventType =
  | 'agent_run_complete'
  | 'tool_execution'
  | 'token_usage'
  | 'billing_payment_success'
  | 'billing_payment_failed'
  | 'security_rate_limit'
  | 'security_webhook_forged'
  | 'knowledge_indexed'
  | 'knowledge_query'
  | 'admin_impersonation'
  | 'eval_completed';

export interface AnalyticsDataPoint {
  event_type: AnalyticsEventType | string;
  space_id?: string;
  agent_id?: string;
  model_id?: string;
  run_id?: string;
  billing_provider?: string;
  credits_used?: number;
  duration_ms?: number;
  token_count?: number;
  amount_cents?: number;
  cache_hit_rate?: number;
  error_count?: number;
  trace_id?: string;
}

export const AE = {
  blobs: {
    event_type: 0,
    user_id: 1,
    agent_id: 2,
    model_id: 3,
    run_id: 4,
    billing_provider: 5,
  },
  doubles: {
    credits_used: 0,
    duration_ms: 1,
    token_count: 2,
    amount_cents: 3,
    cache_hit_rate: 4,
    error_count: 5,
  },
} as const;

// ─── Notification Types ───────────────────────────────────────────────────────

export interface PushNotificationPayload {
  id: string;
  type: string;
  spaceId: string;
  userId?: string;
  data: Record<string, unknown>;
}

export interface DeviceToken {
  userId: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
  registeredAt: string;
}

// ─── MCP Types ────────────────────────────────────────────────────────────────

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface MCPToolResult {
  callId: string;
  output: unknown;
  error?: string;
}
