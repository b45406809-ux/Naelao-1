import { describe, expect, it } from "vitest";
import {
  calculateDeveloperCommission,
  calculateFixedLicenseCommission,
  tierForPlanPrice,
} from "./settlement.js";

describe("template marketplace settlement policy", () => {
  it("applies the corrected 40% pioneer and 25% standard first-six-cycle rates", () => {
    expect(
      calculateDeveloperCommission(2_000, "DEVELOPER_REFERRAL", "entry", 1)
    ).toBe(500);
    expect(
      calculateDeveloperCommission(2_000, "MARKETPLACE_ORGANIC", "entry", 1)
    ).toBe(500);
    expect(calculateDeveloperCommission(2_000, "MARKETPLACE_ORGANIC", "entry", 1, true)).toBe(800);
  });
  it("decays to 20% in months 7–12 and 5% after month 12 without a plan-tier reset", () => {
    expect(
      calculateDeveloperCommission(2_000, "DEVELOPER_REFERRAL", "entry", 7)
    ).toBe(400);
    expect(calculateDeveloperCommission(7_500, "MARKETPLACE_ORGANIC", "growth", 12)).toBe(1_500);
    expect(calculateDeveloperCommission(15_000, "DEVELOPER_REFERRAL", "pro", 13)).toBe(750);
    expect(tierForPlanPrice(15_000)).toBe("pro");
  });
  it("pays fixed licenses entirely to the developer", () => {
    expect(calculateFixedLicenseCommission(49_900)).toBe(49_900);
  });
});
