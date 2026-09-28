import { describe, expect, it } from "vitest";
import { assertTaskEscrow, clampPlanParallelism, PERSONAL_DAILY_BUDGET_USD, PLANS } from "./plans.js";
describe("plans", () => {
  it("defines allowances", () => expect([PLANS.STARTER.monthlyCredits, PLANS.PRO.monthlyCredits, PLANS.ENTERPRISE.monthlyCredits]).toEqual([1200, 4500, 15000]));
  it("clamps starter but unlocks pro", () => {
    expect(clampPlanParallelism("starter", 4)).toBe(1);
    expect(clampPlanParallelism("pro", 4)).toBe(4);
  });
  it("fails closed when a task cannot fund its upfront escrow", () => {
    expect(assertTaskEscrow(30, 30)).toBe(30);
    expect(() => assertTaskEscrow(30, 29)).toThrow("approval required");
    expect(PERSONAL_DAILY_BUDGET_USD).toEqual({ minimum: 3, maximum: 5 });
  });
});
