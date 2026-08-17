import { describe, it, expect } from "vitest";
import { getUsageSummary } from "../../workers/billing/src/quota.js";

// §A1.27: getUsageSummary is the day/week/month rollup the context-usage UI's daily/weekly/
// monthly numbers come from — a genuinely new capability (only a monthly window existed before).
// Tests the real SQL date-window differentiation (not just that the function returns SOMETHING)
// and that the returned limit always matches the plan tier's real monthly ceiling.

function makeDb(quantitiesByWindowClause: Record<string, number>) {
  return {
    prepare(sql: string) {
      return {
        bind(_orgId: string, _metric: string) {
          return {
            async first() {
              const match = Object.keys(quantitiesByWindowClause).find((clause) => sql.includes(clause));
              return { cnt: match ? quantitiesByWindowClause[match] : 0 };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("getUsageSummary", () => {
  it("queries a genuinely different date window per period (day vs week vs month)", async () => {
    const db = makeDb({
      "start of day": 10,
      "-7 days": 50,
      "start of month": 200,
    });
    const summary = await getUsageSummary(db, "org-1", "llm_tokens", "growth");
    expect(summary.daily.used).toBe(10);
    expect(summary.weekly.used).toBe(50);
    expect(summary.monthly.used).toBe(200);
  });

  // Phase 4 (money) added real per-window ceilings (QuotaLimits.maxDailyTokens/maxWeeklyTokens) —
  // before this, every window shared the single monthly figure ("one real ceiling, three views of
  // burn rate"). Now each window reports its OWN real limit for llm_tokens specifically.
  it("llm_tokens: daily/weekly/monthly each report their OWN real per-window ceiling, not one shared figure", async () => {
    const db = makeDb({ "start of day": 0, "-7 days": 0, "start of month": 0 });
    const summary = await getUsageSummary(db, "org-1", "llm_tokens", "business");
    // business tier's real maxDailyTokens/maxWeeklyTokens/maxMonthlyTokens (quota.ts PLAN_LIMITS).
    expect(summary.daily.limit).toBe(2_000_000);
    expect(summary.weekly.limit).toBe(7_000_000);
    expect(summary.monthly.limit).toBe(20_000_000);
  });

  it("a metric with no dedicated daily/weekly ceiling (api_calls) falls back to the monthly limit for every window", async () => {
    const db = makeDb({ "start of day": 0, "-7 days": 0, "start of month": 0 });
    const summary = await getUsageSummary(db, "org-1", "api_calls", "business");
    expect(summary.daily.limit).toBe(summary.weekly.limit);
    expect(summary.weekly.limit).toBe(summary.monthly.limit);
    expect(summary.monthly.limit).toBe(1_000_000); // business tier's real maxApiCallsPerMonth
  });

  it("resolves the correct limit for the infra_credits metric, not llm_tokens' limit", async () => {
    const db = makeDb({ "start of day": 0, "-7 days": 0, "start of month": 0 });
    const summary = await getUsageSummary(db, "org-1", "infra_credits", "free");
    expect(summary.monthly.limit).toBe(5_000); // free tier's maxMonthlyInfraCredits, not maxMonthlyTokens
  });

  it("falls back to a zeroed limit for an unknown plan tier rather than throwing", async () => {
    const db = makeDb({ "start of day": 0, "-7 days": 0, "start of month": 0 });
    const summary = await getUsageSummary(db, "org-1", "llm_tokens", "not-a-real-tier");
    expect(summary.monthly.limit).toBe(0);
  });
});
