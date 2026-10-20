import { describe, expect, it, vi } from "vitest";
import { EntitlementsChecker, getPlanLimits, isFeatureAllowed, isPlanTier } from "./index.js";

function checkerFor(planTier: string | null) {
  const first = vi.fn(async () => planTier === null ? null : { plan_tier: planTier });
  const db = {
    prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })),
  } as unknown as D1Database;
  return { checker: new EntitlementsChecker(db), first };
}

describe("plan tier validation and immutable limits", () => {
  it("recognizes only the four configured tier identifiers", () => {
    for (const tier of ["free", "growth", "business", "enterprise"]) expect(isPlanTier(tier)).toBe(true);
    for (const tier of ["", "unknown", "Enterprise", null, 3]) expect(isPlanTier(tier)).toBe(false);
  });

  it("falls back to the restrictive free tier for missing or corrupt database values", async () => {
    await expect(checkerFor(null).checker.getTenantTier("tenant-a")).resolves.toBe("free");
    await expect(checkerFor("unlimited").checker.getTenantTier("tenant-a")).resolves.toBe("free");
  });

  it("does not let a caller mutate shared tier limits for later quota checks", () => {
    const limits = getPlanLimits("free");
    expect(Object.isFrozen(limits)).toBe(true);
    expect(Reflect.set(limits, "spaces", 1_000_000)).toBe(false);
    expect(getPlanLimits("free").spaces).toBe(3);
    expect(isFeatureAllowed("free", "custom_tools")).toBe(false);
  });

  it("uses free limits for an invalid runtime tier value", () => {
    expect(getPlanLimits("unknown" as never).monthly_tokens).toBe(getPlanLimits("free").monthly_tokens);
  });
});
