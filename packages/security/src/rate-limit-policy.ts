export interface RateLimitRequest {
  key?: string;
  limit: number;
  windowMs: number;
}

export const MAX_RATE_LIMIT = 100_000;
export const MAX_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isValidRateLimitRequest(
  value: unknown
): value is RateLimitRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<RateLimitRequest>;
  const { limit, windowMs } = request;
  return (
    typeof limit === "number" &&
    Number.isSafeInteger(limit) &&
    limit >= 1 &&
    limit <= MAX_RATE_LIMIT &&
    typeof windowMs === "number" &&
    Number.isSafeInteger(windowMs) &&
    windowMs >= 1_000 &&
    windowMs <= MAX_RATE_WINDOW_MS &&
    (request.key === undefined ||
      (typeof request.key === "string" && request.key.length <= 256))
  );
}
