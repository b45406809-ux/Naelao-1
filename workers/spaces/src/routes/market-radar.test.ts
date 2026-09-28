import { evaluateBlueprintSecurity } from "@naelao/security";
import { describe, expect, it } from "vitest";
import { GRADUATION_STAGES } from "./graduation.js";
import { blueprintForOpportunity, scoreMarketSignal } from "./market-radar.js";

describe("market radar and graduation", () => {
  it("tracks the complete graduation lifecycle in order", () => {
    expect(GRADUATION_STAGES).toEqual([
      "consulting_embed",
      "blueprint_staged",
      "marketplace_published",
    ]);
  });

  it("generates a publishable, pre-seeded one-click venture blueprint", () => {
    const blueprint = blueprintForOpportunity({
      id: "solar_permitting",
      name: "Solar Permitting Automation",
    });
    expect(blueprint.projects[0]?.kind).toBe("operations");
    expect(blueprint.projects[0]?.initialTasks).toHaveLength(3);
    expect(blueprint.requiredExtensions.length).toBeGreaterThan(0);
    expect(evaluateBlueprintSecurity(blueprint).publishable).toBe(true);
  });

  it("ranks fast-growing low-saturation markets above crowded ones", () => {
    expect(
      scoreMarketSignal({ search_surge_pct: 118, saturation_index: 14 })
    ).toBeGreaterThan(
      scoreMarketSignal({ search_surge_pct: 30, saturation_index: 80 })
    );
  });
});
