export type DlpRule = "credit_card" | "ssn" | "private_key";

export interface DlpFinding {
  rule: DlpRule;
  count: number;
}
export interface DlpAuditEvent {
  rule: DlpRule;
  timestamp: string;
}
export interface DlpResult<T = unknown> {
  payload: T;
  findings: DlpFinding[];
  audit: DlpAuditEvent[];
}

export class EgressDlpBlockError extends Error {
  readonly code = "egress_dlp_blocked";
  constructor(readonly findings: DlpFinding[]) {
    super("Outbound payload contains protected data");
  }
}

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PAN_CANDIDATE = /(?:\d[ -]?){13,19}/g;
const MAX_EGRESS_SCAN_CHARS = 1_000_000;
const MAX_EGRESS_SCAN_DEPTH = 64;

export function isLuhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits))
    return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Recursively scrubs an egress payload without ever retaining the matched values in findings. */
export function scanAndScrubEgress<T>(
  payload: T,
  policy: "redact" | "block" = "redact"
): DlpResult<T> {
  const counts = new Map<DlpRule, number>();
  const active = new WeakSet<object>();
  let scannedChars = 0;
  const hit = (rule: DlpRule) => counts.set(rule, (counts.get(rule) ?? 0) + 1);
  const scrub = (value: unknown, depth = 0): unknown => {
    if (depth > MAX_EGRESS_SCAN_DEPTH)
      throw new RangeError("egress_dlp_input_too_deep");
    if (typeof value === "string") {
      scannedChars += value.length;
      if (scannedChars > MAX_EGRESS_SCAN_CHARS)
        throw new RangeError("egress_dlp_input_too_large");
      let text = value.replace(PRIVATE_KEY, () => {
        hit("private_key");
        return "[REDACTED_PRIVATE_KEY]";
      });
      text = text.replace(SSN, () => {
        hit("ssn");
        return "[REDACTED_SSN]";
      });
      text = text.replace(PAN_CANDIDATE, (candidate) => {
        if (!isLuhnValid(candidate)) return candidate;
        hit("credit_card");
        return "[REDACTED_CREDIT_CARD]";
      });
      return text;
    }
    if (Array.isArray(value) || (value && typeof value === "object")) {
      if (active.has(value)) throw new TypeError("egress_dlp_circular_payload");
      active.add(value);
      try {
        if (Array.isArray(value))
          return value.map((item) => scrub(item, depth + 1));
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            scrub(key, depth + 1),
            scrub(item, depth + 1),
          ])
        );
      } finally {
        active.delete(value);
      }
    }
    return value;
  };
  const cleaned = scrub(payload) as T;
  const findings = [...counts].map(([rule, count]) => ({ rule, count }));
  if (policy === "block" && findings.length)
    throw new EgressDlpBlockError(findings);
  const timestamp = new Date().toISOString();
  return {
    payload: cleaned,
    findings,
    audit: findings.map(({ rule }) => ({ rule, timestamp })),
  };
}
