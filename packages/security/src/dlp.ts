export type DlpRule = "credit_card" | "ssn" | "private_key";

export interface DlpFinding { rule: DlpRule; count: number }
export interface DlpAuditEvent { rule: DlpRule; timestamp: string }
export interface DlpResult<T = unknown> { payload: T; findings: DlpFinding[]; audit: DlpAuditEvent[] }

export class EgressDlpBlockError extends Error {
  readonly code = "egress_dlp_blocked";
  constructor(readonly findings: DlpFinding[]) { super("Outbound payload contains protected data"); }
}

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PAN_CANDIDATE = /(?:\d[ -]?){13,19}/g;

export function isLuhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double && (digit *= 2) > 9) digit -= 9;
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Recursively scrubs an egress payload without ever retaining the matched values in findings. */
export function scanAndScrubEgress<T>(payload: T, policy: "redact" | "block" = "redact"): DlpResult<T> {
  const counts = new Map<DlpRule, number>();
  const hit = (rule: DlpRule) => counts.set(rule, (counts.get(rule) ?? 0) + 1);
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") {
      let text = value.replace(PRIVATE_KEY, () => { hit("private_key"); return "[REDACTED_PRIVATE_KEY]"; });
      text = text.replace(SSN, () => { hit("ssn"); return "[REDACTED_SSN]"; });
      text = text.replace(PAN_CANDIDATE, (candidate) => {
        if (!isLuhnValid(candidate)) return candidate;
        hit("credit_card");
        return "[REDACTED_CREDIT_CARD]";
      });
      return text;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
    return value;
  };
  const cleaned = scrub(payload) as T;
  const findings = [...counts].map(([rule, count]) => ({ rule, count }));
  if (policy === "block" && findings.length) throw new EgressDlpBlockError(findings);
  const timestamp = new Date().toISOString();
  return { payload: cleaned, findings, audit: findings.map(({ rule }) => ({ rule, timestamp })) };
}
