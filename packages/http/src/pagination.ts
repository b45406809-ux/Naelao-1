/** Parse a request integer and clamp it to a finite, safe range before using it in a query. */
export function parseBoundedInteger(
  value: string | null | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (
    !Number.isSafeInteger(fallback) ||
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum > maximum ||
    fallback < minimum ||
    fallback > maximum
  ) {
    throw new Error("invalid_integer_bounds");
  }
  if (value === null || value === undefined || !/^-?\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}
