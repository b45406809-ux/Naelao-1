// Analytics Engine schema registry — positional field constants
// NEVER use raw positional numbers outside this file

export const SCHEMA_VERSION = 1 as const;

// ─── Schema Definitions ───────────────────────────────────────────────────────

export const AGENT_RUN_SCHEMA = {
  blobs: {
    event_type: 0,
    space_id: 1,
    agent_id: 2,
    run_id: 3,
    model_id: 4,
    billing_provider: 5,
  } as const,
  doubles: {
    credits_used: 0,
    duration_ms: 1,
    input_tokens: 2,
    output_tokens: 3,
    cost_usd: 4,
  } as const,
};

export const TOKEN_USAGE_SCHEMA = {
  blobs: {
    event_type: 0,
    space_id: 1,
    agent_id: 2,
    run_id: 3,
    model_id: 4,
    billing_provider: 5,
  } as const,
  doubles: {
    input_tokens: 0,
    output_tokens: 1,
    credits_charged: 2,
    cost_usd: 3,
  } as const,
};

export const BILLING_EVENT_SCHEMA = {
  blobs: {
    event_type: 0,
    space_id: 1,
    provider: 2,
    subscription_id: 3,
    variant_id: 4,
    currency: 5,
  } as const,
  doubles: {
    amount_cents: 0,
    credits_granted: 1,
  } as const,
};

export const SECURITY_EVENT_SCHEMA = {
  blobs: {
    event_type: 0,
    space_id: 1,
    user_id: 2,
    ip_address: 3,
    endpoint: 4,
    trace_id: 5,
  } as const,
  doubles: {
    request_count: 0,
    blocked: 1,
  } as const,
};

export const KNOWLEDGE_INDEX_SCHEMA = {
  blobs: {
    event_type: 0,
    space_id: 1,
    doc_id: 2,
    project_id: 3,
    mime_type: 4,
    status: 5,
  } as const,
  doubles: {
    chunk_count: 0,
    duration_ms: 1,
    bytes: 2,
  } as const,
};

// ─── Parameter Types ──────────────────────────────────────────────────────────

export interface AgentRunEventParams {
  spaceId: string;
  agentId: string;
  runId: string;
  modelId: string;
  billingProvider: string;
  creditsUsed: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface TokenUsageEventParams {
  spaceId: string;
  agentId: string;
  runId: string;
  modelId: string;
  billingProvider: string;
  inputTokens: number;
  outputTokens: number;
  creditsCharged: number;
  costUsd?: number;
}

export interface BillingEventParams {
  eventType: string;
  spaceId: string;
  provider: string;
  subscriptionId?: string;
  variantId?: string;
  currency: string;
  amountCents: number;
  creditsGranted?: number;
}

export interface SecurityEventParams {
  eventType: string;
  spaceId?: string;
  userId?: string;
  ipAddress?: string;
  endpoint?: string;
  traceId?: string;
  requestCount?: number;
  blocked?: number;
}

export interface KnowledgeIndexEventParams {
  spaceId: string;
  docId: string;
  projectId?: string;
  mimeType?: string;
  status: string;
  chunkCount?: number;
  durationMs?: number;
  bytes?: number;
}

// ─── Write Helpers ────────────────────────────────────────────────────────────

export function writeAgentRunEvent(
  ae: AnalyticsEngineDataset,
  params: AgentRunEventParams
): void {
  const s = AGENT_RUN_SCHEMA;
  const blobs: string[] = new Array(6).fill('');
  blobs[s.blobs.event_type] = 'agent_run_complete';
  blobs[s.blobs.space_id] = params.spaceId;
  blobs[s.blobs.agent_id] = params.agentId;
  blobs[s.blobs.run_id] = params.runId;
  blobs[s.blobs.model_id] = params.modelId;
  blobs[s.blobs.billing_provider] = params.billingProvider;

  const doubles: number[] = new Array(5).fill(0);
  doubles[s.doubles.credits_used] = params.creditsUsed;
  doubles[s.doubles.duration_ms] = params.durationMs;
  doubles[s.doubles.input_tokens] = params.inputTokens;
  doubles[s.doubles.output_tokens] = params.outputTokens;
  doubles[s.doubles.cost_usd] = params.costUsd ?? 0;

  ae.writeDataPoint({ blobs, doubles });
}

export function writeTokenUsageEvent(
  ae: AnalyticsEngineDataset,
  params: TokenUsageEventParams
): void {
  const s = TOKEN_USAGE_SCHEMA;
  const blobs: string[] = new Array(6).fill('');
  blobs[s.blobs.event_type] = 'token_usage';
  blobs[s.blobs.space_id] = params.spaceId;
  blobs[s.blobs.agent_id] = params.agentId;
  blobs[s.blobs.run_id] = params.runId;
  blobs[s.blobs.model_id] = params.modelId;
  blobs[s.blobs.billing_provider] = params.billingProvider;

  const doubles: number[] = new Array(4).fill(0);
  doubles[s.doubles.input_tokens] = params.inputTokens;
  doubles[s.doubles.output_tokens] = params.outputTokens;
  doubles[s.doubles.credits_charged] = params.creditsCharged;
  doubles[s.doubles.cost_usd] = params.costUsd ?? 0;

  ae.writeDataPoint({ blobs, doubles });
}

export function writeBillingEvent(
  ae: AnalyticsEngineDataset,
  params: BillingEventParams
): void {
  const s = BILLING_EVENT_SCHEMA;
  const blobs: string[] = new Array(6).fill('');
  blobs[s.blobs.event_type] = params.eventType;
  blobs[s.blobs.space_id] = params.spaceId;
  blobs[s.blobs.provider] = params.provider;
  blobs[s.blobs.subscription_id] = params.subscriptionId ?? '';
  blobs[s.blobs.variant_id] = params.variantId ?? '';
  blobs[s.blobs.currency] = params.currency;

  const doubles: number[] = new Array(2).fill(0);
  doubles[s.doubles.amount_cents] = params.amountCents;
  doubles[s.doubles.credits_granted] = params.creditsGranted ?? 0;

  ae.writeDataPoint({ blobs, doubles });
}

export function writeSecurityEvent(
  ae: AnalyticsEngineDataset,
  params: SecurityEventParams
): void {
  const s = SECURITY_EVENT_SCHEMA;
  const blobs: string[] = new Array(6).fill('');
  blobs[s.blobs.event_type] = params.eventType;
  blobs[s.blobs.space_id] = params.spaceId ?? '';
  blobs[s.blobs.user_id] = params.userId ?? '';
  blobs[s.blobs.ip_address] = params.ipAddress ?? '';
  blobs[s.blobs.endpoint] = params.endpoint ?? '';
  blobs[s.blobs.trace_id] = params.traceId ?? '';

  const doubles: number[] = new Array(2).fill(0);
  doubles[s.doubles.request_count] = params.requestCount ?? 0;
  doubles[s.doubles.blocked] = params.blocked ?? 0;

  ae.writeDataPoint({ blobs, doubles });
}

export function writeKnowledgeIndexEvent(
  ae: AnalyticsEngineDataset,
  params: KnowledgeIndexEventParams
): void {
  const s = KNOWLEDGE_INDEX_SCHEMA;
  const blobs: string[] = new Array(6).fill('');
  blobs[s.blobs.event_type] = 'knowledge_indexed';
  blobs[s.blobs.space_id] = params.spaceId;
  blobs[s.blobs.doc_id] = params.docId;
  blobs[s.blobs.project_id] = params.projectId ?? '';
  blobs[s.blobs.mime_type] = params.mimeType ?? '';
  blobs[s.blobs.status] = params.status;

  const doubles: number[] = new Array(3).fill(0);
  doubles[s.doubles.chunk_count] = params.chunkCount ?? 0;
  doubles[s.doubles.duration_ms] = params.durationMs ?? 0;
  doubles[s.doubles.bytes] = params.bytes ?? 0;

  ae.writeDataPoint({ blobs, doubles });
}

// ─── Query Builder ────────────────────────────────────────────────────────────

export function buildQuery(
  dataset: string,
  schema: typeof AGENT_RUN_SCHEMA,
  fieldName: keyof (typeof AGENT_RUN_SCHEMA)['blobs'],
  value: string,
  timeRange?: { from: string; to: string }
): string {
  const blobIndex = schema.blobs[fieldName] + 1;
  let query = `SELECT * FROM ${dataset} WHERE blob${blobIndex} = '${value}'`;
  if (timeRange) {
    query += ` AND timestamp >= '${timeRange.from}' AND timestamp <= '${timeRange.to}'`;
  }
  return query;
}
