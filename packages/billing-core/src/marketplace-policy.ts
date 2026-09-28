export type MarketplacePricingModel = "freemium_tiered" | "fixed_license";

export interface MarketplaceListingPricing {
  pricing_model: MarketplacePricingModel;
  price_cents: number;
  planGatedFeatures?: readonly string[];
}

export interface MarketplacePricingValidation {
  valid: boolean;
  errors: string[];
}

/** Enforces the marketplace's two deliberately mutually-exclusive business models. */
export function validateMarketplacePricing(
  listing: MarketplaceListingPricing
): MarketplacePricingValidation {
  const errors: string[] = [];
  if (!Number.isInteger(listing.price_cents) || listing.price_cents < 0) {
    errors.push("price_cents must be a non-negative integer");
  }
  if (listing.pricing_model === "freemium_tiered") {
    if (listing.price_cents !== 0)
      errors.push("freemium_tiered listings must have a $0 install price");
  } else if (listing.pricing_model === "fixed_license") {
    if (listing.price_cents < 4_900 || listing.price_cents > 49_900) {
      errors.push("fixed_license price_cents must be between 4900 and 49900");
    }
    if ((listing.planGatedFeatures?.length ?? 0) > 0) {
      errors.push(
        "fixed_license listings must permanently unlock every feature"
      );
    }
  } else {
    errors.push("pricing_model must be freemium_tiered or fixed_license");
  }
  return { valid: errors.length === 0, errors };
}

export function assertMarketplacePricing(
  listing: MarketplaceListingPricing
): void {
  const result = validateMarketplacePricing(listing);
  if (!result.valid) throw new Error(result.errors.join("; "));
}
