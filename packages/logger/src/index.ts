// Structured JSON logging with PII scrubbing and trace_id propagation

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  trace_id?: string;
  tenant_id?: string;
  service?: string;
  timestamp: string;
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// PII field names to scrub from log output
const PII_FIELDS = new Set([
  "password", "secret", "token", "api_key", "apiKey", "authorization",
  "credit_card", "creditCard", "ssn", "phone", "email", "dob",
  "private_key", "privateKey", "refresh_token", "refreshToken",
]);

// G-N33: Store pattern sources (not compiled /g RegExp objects) to avoid shared
// lastIndex state corruption across concurrent requests in the same isolate.
const PII_PATTERN_SOURCES = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,  // email
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/,               // credit card
  /\b\d{3}-\d{2}-\d{4}\b/,                                   // SSN
] as const;

export function scrubPii(obj: unknown): unknown {
  if (typeof obj === "string") {
    let s = obj;
    for (const src of PII_PATTERN_SOURCES) {
      // Construct a fresh /g regex per call to avoid shared lastIndex across concurrent requests
      s = s.replace(new RegExp(src.source, "g"), "[REDACTED]");
    }
    return s;
  }
  if (Array.isArray(obj)) return obj.map(scrubPii);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = PII_FIELDS.has(k.toLowerCase()) ? "[REDACTED]" : scrubPii(v);
    }
    return result;
  }
  return obj;
}

export class Logger {
  private readonly minLevel: number;

  constructor(
    private readonly service: string,
    minLevel: LogLevel = "info",
    private readonly traceId?: string,
    private readonly tenantId?: string
  ) {
    this.minLevel = LEVEL_ORDER[minLevel];
  }

  withContext(traceId: string, tenantId?: string): Logger {
    return new Logger(this.service, Object.keys(LEVEL_ORDER).find((k) => LEVEL_ORDER[k as LogLevel] === this.minLevel) as LogLevel ?? "info", traceId, tenantId);
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.log("debug", message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.log("info", message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.log("warn", message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.log("error", message, extra);
  }

  private log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const entry: LogEntry = {
      level,
      message,
      service: this.service,
      timestamp: new Date().toISOString(),
      ...(this.traceId ? { trace_id: this.traceId } : {}),
      ...(this.tenantId ? { tenant_id: this.tenantId } : {}),
      ...(extra ? (scrubPii(extra) as Record<string, unknown>) : {}),
    };
    const output = JSON.stringify(entry);
    if (level === "error" || level === "warn") {
      console.error(output);
    } else {
      console.log(output);
    }
  }
}

export function createLogger(service: string, minLevel: LogLevel = "info"): Logger {
  return new Logger(service, minLevel);
}
