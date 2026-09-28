import { describe, expect, it } from "vitest";
import { clampPlanParallelism, PLANS } from "./plans.js";
describe("plans", () => {
  it("defines allowances", () => expect([PLANS.STARTER.monthlyCredits, PLANS.PRO.monthlyCredits, PLANS.ENTERPRISE.monthlyCredits]).toEqual([1200, 4500, 15000]));
  it("clamps starter but unlocks pro", () => {
    expect(clampPlanParallelism("starter", 4)).toBe(1);
    expect(clampPlanParallelism("pro", 4)).toBe(4);
  });
});
