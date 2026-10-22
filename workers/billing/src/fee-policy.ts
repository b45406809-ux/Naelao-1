/** Basis-point settings and provider metadata must never create a fee above gross sales. */
export function normalizeFeeBps(value: unknown, fallbackValue: unknown = 500): number {
  const parse = (candidate: unknown): number | null => {
    if (typeof candidate === "number") return Number.isSafeInteger(candidate) ? candidate : null;
    if (typeof candidate !== "string" || !/^(0|[1-9]\d{0,4})$/.test(candidate)) return null;
    const parsed = Number(candidate);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };

  const fallback = parse(fallbackValue);
  const safeFallback = fallback !== null && fallback >= 0 && fallback <= 10_000 ? fallback : 500;
  const basisPoints = parse(value);
  return basisPoints !== null && basisPoints >= 0 && basisPoints <= 10_000
    ? basisPoints
    : safeFallback;
}
