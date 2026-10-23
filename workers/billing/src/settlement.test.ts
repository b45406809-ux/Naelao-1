import { describe, expect, it } from "vitest";
import {
  calculateDeveloperCommission,
  calculateFixedLicenseCommission,
  settleTemplateSubscriptionPayment,
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

  it("rejects unsafe monetary integers and commission inputs at numeric extremes", () => {
    expect(() => tierForPlanPrice(Number.MAX_SAFE_INTEGER + 1)).toThrow("grossCents");
    expect(() => calculateFixedLicenseCommission(Number.MAX_SAFE_INTEGER + 1)).toThrow("Invalid fixed-license gross");
    expect(() => calculateDeveloperCommission(Number.MAX_SAFE_INTEGER + 1, "MARKETPLACE_ORGANIC", "pro", 13)).toThrow("grossCents");
    expect(() => calculateDeveloperCommission(100, "MARKETPLACE_ORGANIC", "pro", Number.MAX_SAFE_INTEGER + 1)).toThrow("cycle");
  });

  it("settles a webhook against the exact template subscription instead of the latest one in a Space", async () => {
    const seen: Array<{ sql: string; args: unknown[] }> = [];
    let firstCall = 0;
    const db = {
      prepare(sql: string) {
        return { bind(...args: unknown[]) {
          seen.push({ sql, args });
          return { async first() {
            firstCall++;
            if (firstCall === 1) return null;
            if (firstCall === 2) return { id: "sub-target", developer_user_id: "fde", attribution_channel: "MARKETPLACE_ORGANIC", paid_cycles_total: 0, pioneer_eligible: 0 };
            return { cycle_number: 1, developer_cents: 500, platform_cents: 1500 };
          } };
        } };
      },
      async batch() { return [{ success: true }, { success: true, meta: { changes: 1 } }]; },
    } as unknown as D1Database;
    const result = await settleTemplateSubscriptionPayment(db, "space", 2_000, "provider-event", "provider-sub", "sub-target");
    expect(result.subscriptionId).toBe("sub-target");
    expect(seen[1]?.sql).toContain("AND id = ?");
    expect(seen[1]?.args).toEqual(["space", "sub-target"]);
  });
});
