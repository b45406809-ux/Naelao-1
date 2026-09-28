import { describe, expect, it } from "vitest";
import {
  PriceBelowWholesaleFloorError,
  validatePriceFloor,
} from "./price-floor.js";

describe("validatePriceFloor", () => {
  it("accepts the exact base plan plus extension wholesale total", () => {
    expect(
      validatePriceFloor({
        planPriceCents: 2_000,
        extensions: [{ wholesaleFeeCents: 350 }, { wholesaleFeeCents: 150 }],
        requestedPriceCents: 2_500,
      }).floorCents
    ).toBe(2_500);
  });

  it("rejects a first-month price one cent below wholesale", () => {
    expect(() =>
      validatePriceFloor({
        planPriceCents: 2_000,
        extensions: [{ wholesaleFeeCents: 500 }],
        requestedPriceCents: 2_499,
      })
    ).toThrowError(PriceBelowWholesaleFloorError);
    try {
      validatePriceFloor({
        planPriceCents: 2_000,
        extensions: [{ wholesaleFeeCents: 500 }],
        requestedPriceCents: 2_499,
      });
    } catch (error) {
      expect(error).toMatchObject({
        errorCode: "price_below_wholesale_floor",
        status: 400,
        floorCents: 2_500,
      });
    }
  });
});
