import { describe, expect, it, vi } from "vitest";
import { assertExecutionPlanResources, EntitlementsChecker, getExecutionLimits, getPlanLimits, isFeatureAllowed, isPlanTier, isPlanTierAtLeast } from "./index.js";

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

  it("scales one worker-session budget with the subscription's daily token quota", () => {
    expect(getPlanLimits("free").max_worker_tokens).toBe(2_000);
    expect(getPlanLimits("growth").max_worker_tokens).toBe(20_000);
    expect(getPlanLimits("business").max_worker_tokens).toBe(200_000);
    expect(getPlanLimits("enterprise").max_worker_tokens).toBe(2_000_000);
  });

  it("shares plan resource admission between runtime installs and execution", () => {
    expect(getExecutionLimits("free")).toMatchObject({ maxProfile: "standard-1", concurrency: 1 });
    expect(() => assertExecutionPlanResources("free", { cpuCores: .5, memoryMb: 4096 })).not.toThrow();
    expect(() => assertExecutionPlanResources("free", { cpuCores: 1, memoryMb: 6144 })).toThrow("container_subscription_resource_limit");
    expect(() => assertExecutionPlanResources("growth", { cpuCores: 1, memoryMb: 6144 })).not.toThrow();
    expect(() => assertExecutionPlanResources("enterprise", { cpuCores: 2, memoryMb: 16384 })).toThrow("container_subscription_resource_limit");
  });

  it("maps deployment catalogue plan floors conservatively", () => {
    expect(isPlanTierAtLeast("free", "free")).toBe(true);
    expect(isPlanTierAtLeast("free", "pro")).toBe(false);
    expect(isPlanTierAtLeast("growth", "pro")).toBe(true);
    expect(isPlanTierAtLeast("business", "enterprise")).toBe(false);
    expect(isPlanTierAtLeast("corrupt", "pro")).toBe(false);
    expect(isPlanTierAtLeast("enterprise", "unknown")).toBe(false);
  });
});
