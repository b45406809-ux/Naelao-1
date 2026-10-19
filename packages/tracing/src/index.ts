// x-trace-id propagation across service bindings, span writing to Analytics Engine

export interface Span {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  service: string;
  operation: string;
  started_at: string;
  duration_ms?: number;
  status: "ok" | "error";
  attributes: Record<string, string | number | boolean>;
}

export interface TracingConfig {
  service: string;
  dataset: AnalyticsEngineDataset;
}

export interface ActionReceipt {
  tenant_id: string;
  space_id: string;
  action_id: string;
  idempotency_key: string;
  actor_id: string;
  run_id: string;
  task_id: string | null;
  worker_id: string;
  trace_id: string;
  span_id: string;
  action: string;
  input_hash: string;
  output_hash: string;
  grant_id: string | null;
  cost_micros: number;
  outcome: "pending" | "succeeded" | "failed" | "unknown";
  decision_summary: string;
  created_at: string;
  prev_hash: string;
  key_version: string;
  receipt_hash: string;
}

export type ActionReceiptDraft = Omit<
  ActionReceipt,
  "prev_hash" | "receipt_hash"
>;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const MAX_ATTRIBUTE_COUNT = 64;
const MAX_ATTRIBUTE_KEY_CHARS = 128;
const MAX_ATTRIBUTE_VALUE_CHARS = 2_048;
const MAX_ATTRIBUTE_JSON_CHARS = 12_000;

const RECEIPT_FIELDS: readonly (keyof ActionReceiptDraft)[] = [
  "tenant_id",
  "space_id",
  "action_id",
  "idempotency_key",
  "actor_id",
  "run_id",
  "task_id",
  "worker_id",
  "trace_id",
  "span_id",
  "action",
  "input_hash",
  "output_hash",
  "grant_id",
  "cost_micros",
  "outcome",
  "decision_summary",
  "created_at",
  "key_version",
];

export function actionReceiptPayload(
  draft: ActionReceiptDraft,
  previousHash: string
): string {
  return JSON.stringify([
    previousHash,
    ...RECEIPT_FIELDS.map((field) => draft[field]),
  ]);
}

export async function signActionReceipt(
  draft: ActionReceiptDraft,
  previousHash: string,
  secret: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(actionReceiptPayload(draft, previousHash))
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyActionReceiptChain(
  rows: readonly ActionReceipt[],
  secretsByVersion: Readonly<Record<string, string>>,
  genesisHash = "0".repeat(64)
): Promise<{ valid: boolean; entries: number; invalid_action_id?: string }> {
  let previous = genesisHash;
  for (const row of rows) {
    const secret = secretsByVersion[row.key_version];
    if (!secret || row.prev_hash !== previous)
      return {
        valid: false,
        entries: rows.length,
        invalid_action_id: row.action_id,
      };
    const { prev_hash: _prevHash, receipt_hash: _receiptHash, ...draft } = row;
    const expected = await signActionReceipt(draft, previous, secret);
    if (expected !== row.receipt_hash)
      return {
        valid: false,
        entries: rows.length,
        invalid_action_id: row.action_id,
      };
    previous = row.receipt_hash;
  }
  return { valid: true, entries: rows.length };
}

export interface TraceContext {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
}

export function parseTraceparent(
  value: string | null | undefined
): TraceContext | null {
  if (!value) return null;
  const match = /^(?:00)-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(
    value.trim()
  );
  const traceId = match?.[1];
  const parentSpanId = match?.[2];
  const flags = match?.[3];
  if (
    !traceId ||
    !parentSpanId ||
    !flags ||
    /^0+$/.test(traceId) ||
    /^0+$/.test(parentSpanId)
  )
    return null;
  return {
    traceId: traceId.toLowerCase(),
    parentSpanId: parentSpanId.toLowerCase(),
    sampled: (Number.parseInt(flags, 16) & 1) === 1,
  };
}

export function formatTraceparent(
  traceId: string,
  spanId: string,
  sampled = true
): string {
  if (
    !/^[0-9a-f]{32}$/i.test(traceId) ||
    /^0+$/.test(traceId) ||
    !/^[0-9a-f]{16}$/i.test(spanId) ||
    /^0+$/.test(spanId)
  ) {
    throw new Error("invalid_trace_context");
  }
  return `00-${traceId.toLowerCase()}-${spanId.toLowerCase()}-${sampled ? "01" : "00"}`;
}

export function generateTraceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateSpanId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function extractTraceId(
  headers: Headers | Record<string, string | undefined>
): string {
  const get = (h: string) =>
    headers instanceof Headers
      ? (headers.get(h) ?? undefined)
      : (headers as Record<string, string | undefined>)[h];
  const candidate = get("x-trace-id") ?? get("x-request-id");
  return candidate &&
    TRACE_ID_PATTERN.test(candidate) &&
    !/^0+$/.test(candidate)
    ? candidate.toLowerCase()
    : generateTraceId();
}

export function injectTraceId(headers: Headers, traceId: string): void {
  if (!TRACE_ID_PATTERN.test(traceId) || /^0+$/.test(traceId))
    throw new Error("invalid_trace_context");
  headers.set("x-trace-id", traceId);
}

export class Tracer {
  constructor(
    private readonly config: TracingConfig,
    private readonly traceId: string
  ) {
    if (!TRACE_ID_PATTERN.test(traceId) || /^0+$/.test(traceId))
      throw new Error("invalid_trace_context");
    if (!config.service || config.service.length > 256)
      throw new Error("invalid_trace_service");
  }

  startSpan(operation: string, parentSpanId?: string): ActiveSpan {
    if (!operation || operation.length > 256)
      throw new Error("invalid_trace_operation");
    if (parentSpanId !== undefined && !/^[0-9a-f]{16}$/i.test(parentSpanId))
      throw new Error("invalid_trace_context");
    const span: Span = {
      trace_id: this.traceId,
      span_id: generateSpanId(),
      service: this.config.service,
      operation,
      started_at: new Date().toISOString(),
      status: "ok",
      attributes: {},
    };
    if (parentSpanId !== undefined) span.parent_span_id = parentSpanId;
    const startMs = Date.now();
    return new ActiveSpan(span, startMs, this.config.dataset);
  }
}

export class ActiveSpan {
  private ended = false;

  constructor(
    private readonly span: Span,
    private readonly startMs: number,
    private readonly dataset: AnalyticsEngineDataset
  ) {}

  setAttribute(key: string, value: string | number | boolean): this {
    if (
      !key ||
      key.length > MAX_ATTRIBUTE_KEY_CHARS ||
      ["__proto__", "prototype", "constructor"].includes(key)
    )
      throw new Error("invalid_trace_attribute_key");
    if (typeof value === "string" && value.length > MAX_ATTRIBUTE_VALUE_CHARS)
      throw new Error("trace_attribute_value_too_large");
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("invalid_trace_attribute_value");
    if (
      !Object.hasOwn(this.span.attributes, key) &&
      Object.keys(this.span.attributes).length >= MAX_ATTRIBUTE_COUNT
    ) {
      throw new Error("too_many_trace_attributes");
    }
    const previous = this.span.attributes[key];
    this.span.attributes[key] = value;
    if (
      JSON.stringify(this.span.attributes).length > MAX_ATTRIBUTE_JSON_CHARS
    ) {
      if (previous === undefined) delete this.span.attributes[key];
      else this.span.attributes[key] = previous;
      throw new Error("trace_attributes_too_large");
    }
    return this;
  }

  setError(err: unknown): this {
    this.span.status = "error";
    const message = String(err).slice(0, MAX_ATTRIBUTE_VALUE_CHARS);
    try {
      this.setAttribute("error", message);
    } catch {
      // Keep the span status even if the bounded attribute budget is exhausted.
    }
    return this;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.span.duration_ms = Math.max(0, Date.now() - this.startMs);
    this.writeToAE().catch(() => {
      /* best-effort */
    });
  }

  private async writeToAE(): Promise<void> {
    this.dataset.writeDataPoint({
      blobs: [
        this.span.trace_id,
        this.span.span_id,
        this.span.parent_span_id ?? "",
        this.span.service,
        this.span.operation,
        this.span.status,
        JSON.stringify(this.span.attributes),
      ],
      doubles: [this.span.duration_ms ?? 0],
      indexes: [this.span.trace_id],
    });
  }

  get spanId(): string {
    return this.span.span_id;
  }
}

export function createTracer(config: TracingConfig, traceId: string): Tracer {
  return new Tracer(config, traceId);
}
