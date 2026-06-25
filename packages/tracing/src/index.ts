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

export function generateTraceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateSpanId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function extractTraceId(headers: Headers | Record<string, string | undefined>): string {
  const get = (h: string) =>
    headers instanceof Headers ? (headers.get(h) ?? undefined) : (headers as Record<string, string | undefined>)[h];
  return get("x-trace-id") ?? get("x-request-id") ?? generateTraceId();
}

export function injectTraceId(headers: Headers, traceId: string): void {
  headers.set("x-trace-id", traceId);
}

export class Tracer {
  constructor(private readonly config: TracingConfig, private readonly traceId: string) {}

  startSpan(operation: string, parentSpanId?: string): ActiveSpan {
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
    this.span.attributes[key] = value;
    return this;
  }

  setError(err: unknown): this {
    this.span.status = "error";
    this.span.attributes["error"] = String(err);
    return this;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.span.duration_ms = Date.now() - this.startMs;
    this.writeToAE().catch(() => { /* best-effort */ });
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

  get spanId(): string { return this.span.span_id; }
}

export function createTracer(config: TracingConfig, traceId: string): Tracer {
  return new Tracer(config, traceId);
}
