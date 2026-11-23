/**
 * Usage selectors include stable namespaced goal-worker IDs (`graphHash:taskId`). Keep the
 * accepted alphabet narrow because these values cross the public Agent route into Billing.
 */
export function isValidWorkerUsageSelector(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}
