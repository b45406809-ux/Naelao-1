export interface WholesaleExtension {
  id?: string;
  wholesaleFeeCents: number;
}

export interface PriceFloorInput {
  planPriceCents: number;
  extensions: readonly WholesaleExtension[];
  requestedPriceCents: number;
}

export interface PriceFloorResult {
  valid: true;
  floorCents: number;
  requestedPriceCents: number;
}

/** Raised at the checkout boundary when month one cannot cover every wholesale obligation. */
export class PriceBelowWholesaleFloorError extends Error {
  readonly errorCode = "price_below_wholesale_floor";
  readonly status = 400;
  constructor(
    readonly floorCents: number,
    readonly requestedPriceCents: number
  ) {
    super(`First-month price must be at least ${floorCents} cents`);
    this.name = "PriceBelowWholesaleFloorError";
  }
}

function cents(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

/** Enforces base plan + all extension wholesale fees without floating-point currency math. */
export function validatePriceFloor(input: PriceFloorInput): PriceFloorResult {
  const plan = cents(input.planPriceCents, "planPriceCents");
  const requested = cents(input.requestedPriceCents, "requestedPriceCents");
  const extensionTotal = input.extensions.reduce(
    (total, extension, index) =>
      total +
      cents(
        extension.wholesaleFeeCents,
        `extensions[${index}].wholesaleFeeCents`
      ),
    0
  );
  if (
    !Number.isSafeInteger(extensionTotal) ||
    !Number.isSafeInteger(plan + extensionTotal)
  )
    throw new RangeError(
      "Wholesale price floor exceeds the safe integer range"
    );
  const floorCents = plan + extensionTotal;
  if (requested < floorCents)
    throw new PriceBelowWholesaleFloorError(floorCents, requested);
  return { valid: true, floorCents, requestedPriceCents: requested };
}
