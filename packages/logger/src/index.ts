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

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const MAX_LOG_DEPTH = 16;
const MAX_LOG_ITEMS = 100;
const MAX_LOG_STRING_LENGTH = 8_192;
const RESERVED_LOG_FIELDS = new Set([
  "level",
  "message",
  "service",
  "timestamp",
  "trace_id",
  "tenant_id",
]);

const SENSITIVE_FIELDS = new Set([
  "password",
  "passwordhash",
  "passwd",
  "secret",
  "clientsecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "authorization",
  "cookie",
  "setcookie",
  "creditcard",
  "ssn",
  "phone",
  "email",
  "dob",
  "dateofbirth",
  "privatekey",
  "signingkey",
  "credential",
  "credentials",
  "accesskey",
  "secretaccesskey",
]);
const SENSITIVE_FIELD_MARKERS = [
  "password",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "creditcard",
  "ssn",
  "socialsecuritynumber",
  "phone",
  "email",
  "dateofbirth",
  "dob",
  "privatekey",
  "credential",
  "accesskey",
] as const;

const PII_PATTERN_SOURCES = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\b\d{3}\b)[\s.-]\d{3}[\s.-]\d{4}\b/,
] as const;

function scrubString(value: string): string {
  let result =
    value.length > MAX_LOG_STRING_LENGTH
      ? `${value.slice(0, MAX_LOG_STRING_LENGTH)}[TRUNCATED]`
      : value;
  for (const source of PII_PATTERN_SOURCES) {
    result = result.replace(new RegExp(source.source, "g"), "[REDACTED]");
  }
  return result;
}

function isSensitiveField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    SENSITIVE_FIELDS.has(normalized) ||
    SENSITIVE_FIELD_MARKERS.some(
      (marker) => normalized.startsWith(marker) || normalized.endsWith(marker)
    )
  );
}

function scrubValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  budget: { remaining: number }
): unknown {
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_LOG_DEPTH) return "[Max depth]";
  if (seen.has(value)) return "[Circular]";
  if (budget.remaining <= 0) return "[Truncated]";
  budget.remaining--;
  seen.add(value);

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? "[Invalid Date]"
      : value.toISOString();
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return "[Binary data]";
  }
  if (value instanceof Error) {
    return {
      name: scrubString(value.name),
      message: scrubString(value.message),
    };
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_LOG_ITEMS)
      .map((item) => scrubValue(item, seen, depth + 1, budget));
    if (value.length > MAX_LOG_ITEMS)
      items.push(`[${value.length - MAX_LOG_ITEMS} items omitted]`);
    return items;
  }

  const result: Record<string, unknown> = Object.create(null);
  let entries: [string, unknown][];
  try {
    entries = Object.entries(value as Record<string, unknown>);
  } catch {
    return "[Unserializable object]";
  }
  for (const [key, child] of entries.slice(0, MAX_LOG_ITEMS)) {
    result[scrubString(key)] = isSensitiveField(key)
      ? "[REDACTED]"
      : scrubValue(child, seen, depth + 1, budget);
  }
  if (entries.length > MAX_LOG_ITEMS) {
    result._omitted_fields = entries.length - MAX_LOG_ITEMS;
  }
  return result;
}

export function scrubPii(obj: unknown): unknown {
  return scrubValue(obj, new WeakSet(), 0, { remaining: 2_000 });
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
    const level =
      (Object.keys(LEVEL_ORDER) as LogLevel[]).find(
        (key) => LEVEL_ORDER[key] === this.minLevel
      ) ?? "info";
    return new Logger(this.service, level, traceId, tenantId);
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

  private log(
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>
  ): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const safeExtra = Object.fromEntries(
      Object.entries(extra ?? {}).filter(
        ([key]) => !RESERVED_LOG_FIELDS.has(key)
      )
    );
    const entry: LogEntry = {
      ...safeExtra,
      level,
      message,
      service: this.service,
      timestamp: new Date().toISOString(),
      ...(this.traceId ? { trace_id: this.traceId } : {}),
      ...(this.tenantId ? { tenant_id: this.tenantId } : {}),
    };
    const output = JSON.stringify(scrubPii(entry));
    if (level === "error" || level === "warn") {
      console.error(output);
    } else {
      console.log(output);
    }
  }
}

export function createLogger(
  service: string,
  minLevel: LogLevel = "info"
): Logger {
  return new Logger(service, minLevel);
}
