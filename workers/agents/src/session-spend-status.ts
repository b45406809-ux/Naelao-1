export interface SessionSpendStatus {
  credits_used: number;
  warned_80: boolean;
}

/** Invalid or unavailable session spend data must never be interpreted as an unused budget. */
export function parseSessionSpendStatus(value: unknown): SessionSpendStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value as Record<string, unknown>;
  if (!Number.isSafeInteger(status.credits_used) || (status.credits_used as number) < 0
    || typeof status.warned_80 !== "boolean") return null;
  return { credits_used: status.credits_used as number, warned_80: status.warned_80 };
}
