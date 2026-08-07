import { describe, it, expect } from "vitest";
import {
  ALLOWED_MODELS,
  MODEL_BENCHMARKS,
  listModelBenchmarks,
  benchmarkForModel,
  costRankForModel,
  validateModelBenchmarks,
  EFFORT_LEVELS,
  effortLadderForModel,
  isValidEffortLevel,
  nativeReasoningForEffort,
  escalationCeiling,
  resolveEscalationModel,
  effortOptionsForModel,
  DEFAULT_WORKING_MODEL,
} from "@naelao/billing-core";

describe("model-benchmarks — real data, no gaps", () => {
  it("has a benchmark entry for every curated model and nothing extra", () => {
    expect(() => validateModelBenchmarks()).not.toThrow();
    for (const m of ALLOWED_MODELS) expect(MODEL_BENCHMARKS[m]).toBeDefined();
  });

  it("listModelBenchmarks sorts cheapest tier first", () => {
    const list = listModelBenchmarks();
    const rankOrder = list.map((b) => costRankForModel(b.id));
    const sorted = [...rankOrder].sort((a, b) => a - b);
    expect(rankOrder).toEqual(sorted);
  });

  it("never invents a $ price for a model it hasn't measured — costBasis is honest", () => {
    for (const b of Object.values(MODEL_BENCHMARKS)) {
      expect(["measured", "estimated"]).toContain(b.costBasis);
      if (b.costBasis === "estimated") {
        // An estimate must say so in its own note, not just carry the label silently.
        expect(b.costNote.length).toBeGreaterThan(10);
      }
    }
  });

  it("the account's default working model carries our own REAL measured eval numbers", () => {
    const bench = benchmarkForModel(DEFAULT_WORKING_MODEL);
    expect(bench?.eval).toBeDefined();
    expect(bench!.eval!.dataset).toContain("tool-use-policy");
    expect(bench!.eval!.usable).toBe("6/6");
  });

  it("benchmarkForModel returns undefined for a model outside the curated list", () => {
    expect(benchmarkForModel("not-a-real-model")).toBeUndefined();
  });
});

describe("effort — every model gets at least low + medium", () => {
  it("a model with no native reasoning still offers exactly low+medium", () => {
    const ladder = effortLadderForModel(DEFAULT_WORKING_MODEL); // llama-3.3, NO_REASONING
    expect(ladder.map((o) => o.level)).toEqual(["low", "medium"]);
  });

  it("a model with a 3-level native reasoning ladder offers the full low..ultra range", () => {
    const ladder = effortLadderForModel("@cf/openai/gpt-oss-120b"); // low/medium/high
    expect(ladder.map((o) => o.level)).toEqual(["low", "medium", "high", "ultra"]);
  });

  it("a model with a 2-level native reasoning ladder offers low..high but not ultra", () => {
    const glm = effortLadderForModel("@cf/zai-org/glm-5.2"); // high/max
    expect(glm.map((o) => o.level)).toEqual(["low", "medium", "high"]);
    const kimi = effortLadderForModel("@cf/moonshotai/kimi-k2.6"); // off/on
    expect(kimi.map((o) => o.level)).toEqual(["low", "medium", "high"]);
  });

  it("every effort option carries a non-empty description", () => {
    for (const level of EFFORT_LEVELS) {
      const opt = effortOptionsForModel("@cf/openai/gpt-oss-120b").find((o) => o.level === level);
      expect(opt?.description.length).toBeGreaterThan(20);
    }
  });

  it("isValidEffortLevel rejects a level the model's own ladder doesn't offer", () => {
    expect(isValidEffortLevel(DEFAULT_WORKING_MODEL, "low")).toBe(true);
    expect(isValidEffortLevel(DEFAULT_WORKING_MODEL, "high")).toBe(false);
    expect(isValidEffortLevel(DEFAULT_WORKING_MODEL, "ultra")).toBe(false);
    expect(isValidEffortLevel("@cf/openai/gpt-oss-120b", "ultra")).toBe(true);
  });

  it("nativeReasoningForEffort returns null for a non-reasoning model at any level", () => {
    expect(nativeReasoningForEffort(DEFAULT_WORKING_MODEL, "low")).toBeNull();
    expect(nativeReasoningForEffort(DEFAULT_WORKING_MODEL, "medium")).toBeNull();
  });

  it("nativeReasoningForEffort spreads effort levels across a model's real native levels", () => {
    expect(nativeReasoningForEffort("@cf/openai/gpt-oss-120b", "low")).toBe("low");
    expect(nativeReasoningForEffort("@cf/openai/gpt-oss-120b", "medium")).toBe("medium");
    expect(nativeReasoningForEffort("@cf/openai/gpt-oss-120b", "high")).toBe("high");
    expect(nativeReasoningForEffort("@cf/openai/gpt-oss-120b", "ultra")).toBe("high"); // clamped, no 4th native level
  });

  it("nativeReasoningForEffort saturates at a 2-level model's own top once Effort reaches medium", () => {
    expect(nativeReasoningForEffort("@cf/zai-org/glm-5.2", "low")).toBe("high"); // glm's OWN lowest is called "high"
    expect(nativeReasoningForEffort("@cf/zai-org/glm-5.2", "medium")).toBe("max");
    expect(nativeReasoningForEffort("@cf/zai-org/glm-5.2", "high")).toBe("max");
    expect(nativeReasoningForEffort("@cf/moonshotai/kimi-k2.6", "low")).toBe("off");
    expect(nativeReasoningForEffort("@cf/moonshotai/kimi-k2.6", "medium")).toBe("on");
    expect(nativeReasoningForEffort("@cf/moonshotai/kimi-k2.6", "high")).toBe("on");
  });
});

describe("escalation ceiling and resolveEscalationModel — the actual cost-control mechanism", () => {
  it("low pins delegation to the single cheapest model, regardless of current model's own cost", () => {
    const cheapestRank = 1;
    expect(escalationCeiling("@cf/zai-org/glm-5.2" /* premium */, "low")).toBe(cheapestRank);
    expect(escalationCeiling(DEFAULT_WORKING_MODEL /* economy */, "low")).toBe(cheapestRank);
  });

  it("medium allows exactly one tier above the current model, never unlimited", () => {
    const economyModel = DEFAULT_WORKING_MODEL; // rank 1 (economy)
    const ceiling = escalationCeiling(economyModel, "medium");
    expect(ceiling).toBe(2); // one tier up from economy -> standard
  });

  it("ultra removes the ceiling entirely — the top rank among curated models", () => {
    const ceiling = escalationCeiling(DEFAULT_WORKING_MODEL, "ultra");
    const maxRank = Math.max(...ALLOWED_MODELS.map((m) => costRankForModel(m)));
    expect(ceiling).toBe(maxRank);
  });

  it("with no preferred model, picks the best model affordable under the ceiling", () => {
    const res = resolveEscalationModel(DEFAULT_WORKING_MODEL, "low");
    expect(res.downgraded).toBe(false);
    expect(costRankForModel(res.model)).toBe(1);
  });

  it("a preferred model within budget is used unchanged, no downgrade", () => {
    const res = resolveEscalationModel(DEFAULT_WORKING_MODEL, "ultra", { preferModel: "@cf/zai-org/glm-5.2" });
    expect(res.downgraded).toBe(false);
    expect(res.model).toBe("@cf/zai-org/glm-5.2");
  });

  it("REPRODUCES THE REPORTED SCENARIO: effort=low, an expensive model is requested -> downgraded with an honest reason, never silently run", () => {
    const res = resolveEscalationModel(DEFAULT_WORKING_MODEL, "low", { preferModel: "@cf/zai-org/glm-5.2" /* premium */ });
    expect(res.downgraded).toBe(true);
    expect(res.reason).toBeTruthy();
    expect(res.reason).toContain("Effort setting");
    // And the model it actually resolved to must be within the low ceiling (cheapest tier).
    expect(costRankForModel(res.model)).toBe(1);
  });

  it("a preferred model that isn't curated at all also downgrades rather than passing through unchecked", () => {
    const res = resolveEscalationModel(DEFAULT_WORKING_MODEL, "low", { preferModel: "some-made-up-model" });
    expect(res.downgraded).toBe(true);
    expect(ALLOWED_MODELS).toContain(res.model);
  });

  it("resolveEscalationModel always returns a curated model, even for an unrecognized current model", () => {
    const res = resolveEscalationModel("not-a-real-model", "medium");
    expect(ALLOWED_MODELS).toContain(res.model);
  });
});
