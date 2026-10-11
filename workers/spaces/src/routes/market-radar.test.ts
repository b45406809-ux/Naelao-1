import { evaluateBlueprintSecurity } from "@naelao/security";
import { describe, expect, it, vi } from "vitest";
import { GRADUATION_STAGES } from "./graduation.js";
import { blueprintForOpportunity, scoreMarketSignal, scoreMarketSignalWithSentry } from "./market-radar.js";

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

  it("uses a confident typed Jev/Laya score and falls back deterministically", async () => {
    const signal = { search_surge_pct: 118, saturation_index: 14 };
    const score = vi.fn(async () => ({
      kind: "score" as const, value: 8.1, provider: "laya" as const,
      policyCode: "market_radar_opportunity_v1", confidence: 0.91,
    }));
    await expect(scoreMarketSignalWithSentry(signal, { score } as never)).resolves.toEqual({ score: 90, provider: "laya" });

    score.mockRejectedValueOnce(new Error("offline"));
    await expect(scoreMarketSignalWithSentry(signal, { score } as never)).resolves.toEqual({
      score: scoreMarketSignal(signal), provider: "deterministic",
    });
  });
});
