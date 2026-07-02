// Versioned Analytics Engine event schemas and slot assignment registry
// CF Analytics Engine: blobs[1..20], doubles[1..20], indexes[1] per data point

export type EventType =
  | "session.started"
  | "session.ended"
  | "message.sent"
  | "message.received"
  | "agent.run.started"
  | "agent.run.completed"
  | "agent.run.failed"
  | "tool.call"
  | "kb.query"
  | "kb.document.ingested"
  | "space.created"
  | "space.deleted"
  | "billing.usage"
  | "auth.login"
  | "auth.token.refresh"
  | "error";

// Slot assignments for Analytics Engine data points (fixed schema, DO NOT CHANGE ORDER)
export interface AeSlots {
  blobs: [
    string, // b1: event_type
    string, // b2: tenant_id
    string, // b3: space_id
    string, // b4: session_id
    string, // b5: user_id
    string, // b6: environment
    string, // b7: service
    string, // b8: trace_id
    string, // b9: error_code (or "")
    string, // b10: metadata_json
    string, // b11-b20: reserved
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  doubles: [
    number, // d1: duration_ms
    number, // d2: token_count
    number, // d3: cost_usd_micro (cost * 1,000,000)
    number, // d4: value (generic numeric value for billing/usage)
    number, // d5-d20: reserved
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  indexes: [string]; // tenant_id for fast tenant-scoped queries
}

export interface BaseEvent {
  event_type: EventType;
  tenant_id: string;
  space_id?: string;
  session_id?: string;
  user_id?: string;
  environment: string;
  service: string;
  trace_id?: string;
  error_code?: string;
  duration_ms?: number;
  token_count?: number;
  cost_usd_micro?: number;
  value?: number;
  metadata?: Record<string, unknown>;
}

export function buildAeDataPoint(event: BaseEvent): AeSlots {
  return {
    blobs: [
      event.event_type,
      event.tenant_id,
      event.space_id ?? "",
      event.session_id ?? "",
      event.user_id ?? "",
      event.environment,
      event.service,
      event.trace_id ?? "",
      event.error_code ?? "",
      event.metadata ? JSON.stringify(event.metadata) : "",
      "", "", "", "", "", "", "", "", "", "",
    ],
    doubles: [
      event.duration_ms ?? 0,
      event.token_count ?? 0,
      event.cost_usd_micro ?? 0,
      event.value ?? 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
    indexes: [event.tenant_id],
  };
}

export function writeEvent(dataset: AnalyticsEngineDataset, event: BaseEvent): void {
  const slots = buildAeDataPoint(event);
  dataset.writeDataPoint({
    blobs: slots.blobs,
    doubles: slots.doubles,
    indexes: slots.indexes,
  });
}

// Typed event constructors
export function sessionStartedEvent(params: {
  tenant_id: string;
  space_id: string;
  session_id: string;
  user_id?: string;
  environment: string;
  service: string;
  trace_id?: string;
}): BaseEvent {
  return { event_type: "session.started", ...params };
}

export function messageEvent(params: {
  tenant_id: string;
  space_id: string;
  session_id: string;
  direction: "sent" | "received";
  token_count?: number;
  cost_usd_micro?: number;
  environment: string;
  service: string;
  trace_id?: string;
}): BaseEvent {
  const event: BaseEvent = {
    event_type: params.direction === "sent" ? "message.sent" : "message.received",
    tenant_id: params.tenant_id,
    space_id: params.space_id,
    session_id: params.session_id,
    environment: params.environment,
    service: params.service,
  };
  if (params.trace_id !== undefined) event.trace_id = params.trace_id;
  if (params.token_count !== undefined) event.token_count = params.token_count;
  if (params.cost_usd_micro !== undefined) event.cost_usd_micro = params.cost_usd_micro;
  return event;
}

export function agentRunEvent(params: {
  tenant_id: string;
  space_id: string;
  session_id: string;
  run_id: string;
  status: "started" | "completed" | "failed";
  duration_ms?: number;
  token_count?: number;
  cost_usd_micro?: number;
  error_code?: string;
  environment: string;
  service: string;
}): BaseEvent {
  const event_type: EventType =
    params.status === "started" ? "agent.run.started"
    : params.status === "completed" ? "agent.run.completed"
    : "agent.run.failed";
  const event: BaseEvent = {
    event_type,
    tenant_id: params.tenant_id,
    space_id: params.space_id,
    session_id: params.session_id,
    environment: params.environment,
    service: params.service,
    metadata: { run_id: params.run_id },
  };
  if (params.duration_ms !== undefined) event.duration_ms = params.duration_ms;
  if (params.token_count !== undefined) event.token_count = params.token_count;
  if (params.cost_usd_micro !== undefined) event.cost_usd_micro = params.cost_usd_micro;
  if (params.error_code !== undefined) event.error_code = params.error_code;
  return event;
}
