import { describe, expect, it } from "vitest";
import {
  calculateDeveloperCommission,
  calculateFixedLicenseCommission,
  tierForPlanPrice,
} from "./settlement.js";

describe("template marketplace settlement policy", () => {
  it("pays direct referrals 40% and organic installs 20%", () => {
    expect(
      calculateDeveloperCommission(2_000, "DEVELOPER_REFERRAL", "entry", 1)
    ).toBe(800);
    expect(
      calculateDeveloperCommission(2_000, "MARKETPLACE_ORGANIC", "entry", 1)
    ).toBe(400);
  });
  it("stops entry commission after six cumulative cycles", () => {
    expect(
      calculateDeveloperCommission(2_000, "DEVELOPER_REFERRAL", "entry", 6)
    ).toBe(800);
    expect(
      calculateDeveloperCommission(2_000, "DEVELOPER_REFERRAL", "entry", 7)
    ).toBe(0);
  });
  it("stops growth commission after twelve cumulative cycles", () => {
    expect(calculateDeveloperCommission(7_500, "MARKETPLACE_ORGANIC", "growth", 12)).toBe(1_500);
    expect(calculateDeveloperCommission(7_500, "MARKETPLACE_ORGANIC", "growth", 13)).toBe(0);
  });
  it("restores unlimited commission at the pro tier", () => {
    expect(tierForPlanPrice(15_000)).toBe("pro");
    expect(
      calculateDeveloperCommission(15_000, "DEVELOPER_REFERRAL", "pro", 10_000)
    ).toBe(6_000);
  });
  it("pays fixed licenses entirely to the developer", () => {
    expect(calculateFixedLicenseCommission(49_900)).toBe(49_900);
  });
});
