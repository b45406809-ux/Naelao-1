export const MAX_API_KEY_EXPIRY_DAYS = 3650;

/** Parse the optional UI value without truncating decimals or accepting empty zero values. */
export function parseApiKeyExpiryDays(value: string): number | undefined | null {
  if (!value.trim()) return undefined;
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_API_KEY_EXPIRY_DAYS) return null;
  return days;
}
