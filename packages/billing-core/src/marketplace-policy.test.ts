import { describe, expect, it } from "vitest";
import { validateMarketplacePricing } from "./marketplace-policy.js";

describe("validateMarketplacePricing", () => {
  it("allows free tier-gated SaaS", () => {
    expect(
      validateMarketplacePricing({
        pricing_model: "freemium_tiered",
        price_cents: 0,
        planGatedFeatures: ["pro-export"],
      }).valid
    ).toBe(true);
  });
  it("allows an all-unlocked fixed license", () => {
    expect(
      validateMarketplacePricing({
        pricing_model: "fixed_license",
        price_cents: 4_900,
      }).valid
    ).toBe(true);
  });
  it("rejects charging upfront while gating features", () => {
    const result = validateMarketplacePricing({
      pricing_model: "fixed_license",
      price_cents: 9_900,
      planGatedFeatures: ["reports"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("every feature");
  });
});
