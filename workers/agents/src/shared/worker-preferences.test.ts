import { describe, expect, it } from "vitest";
import { resolveWorkerPreferences, type WorkerPreferenceInput } from "./worker-preferences.js";

const COST = { economy: 1, standard: 4, premium: 15 } as const;

function input(overrides: Partial<WorkerPreferenceInput> = {}): WorkerPreferenceInput {
  return {
    planLimits: { maxWorkers: 10 },
    modelTierCost: COST,
    ...overrides,
  };
}

describe("resolveWorkerPreferences", () => {
  it("uses defaults when no layer sets anything", () => {
    const r = resolveWorkerPreferences(input());
    expect(r.workerCount).toBe(3);
    expect(r.goalCreditCeiling).toBe(200);
    expect(r.allowedModelTiers).toEqual(["economy", "standard", "premium"]);
    expect(r.preferredModelTier).toBe("economy");
    expect(r.fallbackTiers).toEqual([]);
    expect(r.sources).toEqual({
      workerCount: "default",
      goalCreditCeiling: "default",
      allowedModelTiers: "all-known",
      preferredModelTier: "cheapest-allowed",
      clamped: [],
      ignored: [],
    });
  });

  it("lets the tightest worker limit win across plan, space and project", () => {
    const planTight = resolveWorkerPreferences(input({ planLimits: { maxWorkers: 2 } }));
    expect(planTight.workerCount).toBe(2);
    expect(planTight.sources.workerCount).toBe("plan");

    const spaceTight = resolveWorkerPreferences(input({ spaceLimits: { maxWorkers: 4 } }));
    expect(spaceTight.workerCount).toBe(3);

    const spaceBinds = resolveWorkerPreferences(
      input({ planLimits: { maxWorkers: 10 }, spaceLimits: { maxWorkers: 1 } }),
    );
    expect(spaceBinds.workerCount).toBe(1);
    expect(spaceBinds.sources.workerCount).toBe("space");

    const projectBinds = resolveWorkerPreferences(
      input({ spaceLimits: { maxWorkers: 6 }, projectSettings: { maxWorkers: 2 } }),
    );
    expect(projectBinds.workerCount).toBe(2);
    expect(projectBinds.sources.workerCount).toBe("project");
  });

  it("lets a user pick a worker count at or below the effective limit", () => {
    const r = resolveWorkerPreferences(
      input({ spaceLimits: { maxWorkers: 6 }, userPreferences: { workerCount: 5 } }),
    );
    expect(r.workerCount).toBe(5);
    expect(r.sources.workerCount).toBe("user");
    expect(r.sources.clamped).toEqual([]);
  });

  it("user cannot exceed the admin limit and the clamp is reported", () => {
    const r = resolveWorkerPreferences(
      input({ spaceLimits: { maxWorkers: 2 }, userPreferences: { workerCount: 9 } }),
    );
    expect(r.workerCount).toBe(2);
    expect(r.sources.clamped).toContain("user.workerCount:9->2");
  });

  it("admin cannot exceed the plan limit", () => {
    const r = resolveWorkerPreferences(
      input({ planLimits: { maxWorkers: 4 }, spaceLimits: { maxWorkers: 8 }, userPreferences: { workerCount: 8 } }),
    );
    expect(r.workerCount).toBe(4);
    expect(r.sources.clamped).toContain("space.maxWorkers:8->4");
    expect(r.sources.clamped).toContain("user.workerCount:8->4");
  });

  it("clamps admin worker max to the 1..10 range and reports it", () => {
    const high = resolveWorkerPreferences(
      input({ planLimits: { maxWorkers: 32 }, spaceLimits: { maxWorkers: 50 }, userPreferences: { workerCount: 20 } }),
    );
    expect(high.workerCount).toBe(10);
    expect(high.sources.clamped).toContain("space.maxWorkers:50->10");
    expect(high.sources.clamped).toContain("user.workerCount:20->10");

    const low = resolveWorkerPreferences(input({ spaceLimits: { maxWorkers: 0 } }));
    expect(low.workerCount).toBe(1);
    expect(low.sources.clamped).toContain("space.maxWorkers:0->1");
  });

  it("ignores invalid worker counts and reports them", () => {
    for (const bad of [Number.NaN, -2, 2.5, Number.POSITIVE_INFINITY]) {
      const r = resolveWorkerPreferences(
        input({ spaceLimits: { maxWorkers: bad }, userPreferences: { workerCount: bad } }),
      );
      expect(r.workerCount).toBe(3);
      expect(r.sources.ignored).toContain("space.maxWorkers:invalid");
      expect(r.sources.ignored).toContain("user.workerCount:invalid");
    }
  });

  it("goal credit ceiling defaults to 200 and tightest admin or project value wins", () => {
    const r = resolveWorkerPreferences(
      input({ spaceLimits: { goalCreditCeiling: 150 }, projectSettings: { goalCreditCeiling: 90 } }),
    );
    expect(r.goalCreditCeiling).toBe(90);
    expect(r.sources.goalCreditCeiling).toBe("project");
  });

  it("an admin may raise the ceiling above the default", () => {
    const r = resolveWorkerPreferences(input({ spaceLimits: { goalCreditCeiling: 500 } }));
    expect(r.goalCreditCeiling).toBe(500);
    expect(r.sources.goalCreditCeiling).toBe("space");
  });

  it("a user may only lower the goal credit ceiling", () => {
    const lower = resolveWorkerPreferences(input({ userPreferences: { goalCreditCeiling: 50 } }));
    expect(lower.goalCreditCeiling).toBe(50);
    expect(lower.sources.goalCreditCeiling).toBe("user");

    const higher = resolveWorkerPreferences(
      input({ spaceLimits: { goalCreditCeiling: 120 }, userPreferences: { goalCreditCeiling: 999 } }),
    );
    expect(higher.goalCreditCeiling).toBe(120);
    expect(higher.sources.goalCreditCeiling).toBe("space");
    expect(higher.sources.clamped).toContain("user.goalCreditCeiling:999->120");
  });

  it("ignores invalid ceilings and reports them", () => {
    const r = resolveWorkerPreferences(
      input({
        planLimits: { maxWorkers: 10, goalCreditCeiling: Number.NaN },
        spaceLimits: { goalCreditCeiling: -5 },
        userPreferences: { goalCreditCeiling: 12.5 },
      }),
    );
    expect(r.goalCreditCeiling).toBe(200);
    expect(r.sources.ignored).toEqual(
      expect.arrayContaining([
        "plan.goalCreditCeiling:invalid",
        "space.goalCreditCeiling:invalid",
        "user.goalCreditCeiling:invalid",
      ]),
    );
  });

  it("intersects allowed model tiers across layers that set them", () => {
    const r = resolveWorkerPreferences(
      input({
        planLimits: { maxWorkers: 10, allowedModelTiers: ["economy", "standard", "premium"] },
        spaceLimits: { allowedModelTiers: ["standard", "premium"] },
        projectSettings: { allowedModelTiers: ["premium"] },
      }),
    );
    expect(r.allowedModelTiers).toEqual(["premium"]);
    expect(r.preferredModelTier).toBe("premium");
    expect(r.sources.allowedModelTiers).toBe("intersection");
  });

  it("user picks an allowed tier; an unavailable pick falls back to the cheapest allowed", () => {
    const picked = resolveWorkerPreferences(
      input({ spaceLimits: { allowedModelTiers: ["economy", "standard"] }, userPreferences: { preferredModelTier: "standard" } }),
    );
    expect(picked.preferredModelTier).toBe("standard");
    expect(picked.sources.preferredModelTier).toBe("user");

    const notAllowed = resolveWorkerPreferences(
      input({ spaceLimits: { allowedModelTiers: ["economy", "standard"] }, userPreferences: { preferredModelTier: "premium" } }),
    );
    expect(notAllowed.preferredModelTier).toBe("economy");
    expect(notAllowed.sources.preferredModelTier).toBe("cheapest-allowed");
    expect(notAllowed.sources.ignored).toContain("user.preferredModelTier:not-allowed");
  });

  it("fallback tiers are never more expensive than the preferred tier, most expensive first", () => {
    const r = resolveWorkerPreferences(
      input({
        modelTierCost: { a: 1, b: 4, c: 4, d: 15 },
        userPreferences: { preferredModelTier: "c" },
      }),
    );
    expect(r.preferredModelTier).toBe("c");
    expect(r.fallbackTiers).toEqual(["b", "a"]);
    expect(r.fallbackTiers).not.toContain("d");
    expect(r.fallbackTiers).not.toContain("c");
  });

  it("cheapest preferred tier has no fallbacks", () => {
    const r = resolveWorkerPreferences(input({ userPreferences: { preferredModelTier: "economy" } }));
    expect(r.fallbackTiers).toEqual([]);
  });

  it("empty allowed set gives a null preference and host default only", () => {
    const r = resolveWorkerPreferences(
      input({ spaceLimits: { allowedModelTiers: [] }, userPreferences: { preferredModelTier: "economy" } }),
    );
    expect(r.allowedModelTiers).toEqual([]);
    expect(r.preferredModelTier).toBeNull();
    expect(r.fallbackTiers).toEqual([]);
    expect(r.sources.preferredModelTier).toBe("none");
    expect(r.sources.ignored).toContain("user.preferredModelTier:no-allowed-tiers");
    expect(r.workerCount).toBe(3);
  });

  it("drops unknown tier names from a layer and reports them", () => {
    const r = resolveWorkerPreferences(
      input({ spaceLimits: { allowedModelTiers: ["standard", "ghost"] } }),
    );
    expect(r.allowedModelTiers).toEqual(["standard"]);
    expect(r.sources.ignored).toContain("space.allowedModelTiers:unknown-tier");
  });

  it("invalid tier costs are ignored, so that tier is never allowed", () => {
    const r = resolveWorkerPreferences(
      input({ modelTierCost: { economy: 1, broken: Number.NaN } }),
    );
    expect(r.allowedModelTiers).toEqual(["economy"]);
    expect(r.sources.ignored).toContain("modelTierCost.broken:invalid");
  });

  it("invalid plan worker count fails closed to one worker and is reported", () => {
    const r = resolveWorkerPreferences(input({ planLimits: { maxWorkers: Number.NaN } }));
    expect(r.workerCount).toBe(1);
    expect(r.sources.ignored).toContain("plan.maxWorkers:invalid");
  });
});
