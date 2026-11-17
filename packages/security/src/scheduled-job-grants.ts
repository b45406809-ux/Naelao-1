/** Host-side validation for the optional extra autonomy and spend ceiling assigned to one
 * scheduled goal. These grants can only select operations exposed by the configured agent; the
 * runtime still intersects them with enabled tools and mandatory gates. */
export const MAX_SCHEDULED_JOB_APPROVED_ACTIONS = 64;
export const MAX_SCHEDULED_JOB_RUN_CREDITS = 1_000_000;

export interface ScheduledJobGrantConfig {
  approvedActions: string[];
  maxRunCredits: number;
}

export function validateScheduledJobGrantConfig(approvedActions: unknown, maxRunCredits: unknown): ScheduledJobGrantConfig | null {
  if (!Array.isArray(approvedActions) || approvedActions.length > MAX_SCHEDULED_JOB_APPROVED_ACTIONS
    || approvedActions.some(item => typeof item !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(item))
    || !Number.isSafeInteger(maxRunCredits) || (maxRunCredits as number) < 0 || (maxRunCredits as number) > MAX_SCHEDULED_JOB_RUN_CREDITS)
    return null;
  const normalized = [...new Set(approvedActions as string[])].sort();
  if (normalized.length !== approvedActions.length || normalized.length > 0 && maxRunCredits === 0) return null;
  return { approvedActions: normalized, maxRunCredits: maxRunCredits as number };
}

export function parseScheduledJobGrantConfig(approvedActionsJson: unknown, maxRunCredits: unknown): ScheduledJobGrantConfig | null {
  if (typeof approvedActionsJson !== "string" || approvedActionsJson.length > 16_384) return null;
  try { return validateScheduledJobGrantConfig(JSON.parse(approvedActionsJson), maxRunCredits); }
  catch { return null; }
}
