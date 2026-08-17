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
  // Regression: the ladder used to be capped by the model's own native reasoning depth, so on
  // llama-3.3 (no thinking mode) picking "ultra" was rejected outright — the reported bug. Effort
  // also sets the DELEGATION ceiling, which is meaningful for every model and most meaningful for
  // a weak one, so every model now offers the full range.
  it("a model with no native reasoning still offers the full low..ultra range", () => {
    const ladder = effortLadderForModel(DEFAULT_WORKING_MODEL); // llama-3.3, NO_REASONING
    expect(ladder.map((o) => o.level)).toEqual(["low", "medium", "high", "ultra"]);
  });

  it("says plainly that a non-reasoning model's Effort only changes delegation", () => {
    const ladder = effortLadderForModel(DEFAULT_WORKING_MODEL);
    expect(ladder.every((o) => /no adjustable thinking depth/i.test(o.description))).toBe(true);
    // A model that DOES think keeps the plain description, with no such caveat.
    const thinking = effortLadderForModel("@cf/openai/gpt-oss-120b");
    expect(thinking.some((o) => /no adjustable thinking depth/i.test(o.description))).toBe(false);
  });

  it("a model with a 3-level native reasoning ladder offers the full low..ultra range", () => {
    const ladder = effortLadderForModel("@cf/openai/gpt-oss-120b"); // low/medium/high
    expect(ladder.map((o) => o.level)).toEqual(["low", "medium", "high", "ultra"]);
  });

  it("a model with a 2-level native reasoning ladder also offers all four", () => {
    const glm = effortLadderForModel("@cf/zai-org/glm-5.2"); // high/max
    expect(glm.map((o) => o.level)).toEqual(["low", "medium", "high", "ultra"]);
    const kimi = effortLadderForModel("@cf/moonshotai/kimi-k2.6"); // off/on
    expect(kimi.map((o) => o.level)).toEqual(["low", "medium", "high", "ultra"]);
  });

  it("every effort option carries a non-empty description", () => {
    for (const level of EFFORT_LEVELS) {
      const opt = effortOptionsForModel("@cf/openai/gpt-oss-120b").find((o) => o.level === level);
      expect(opt?.description.length).toBeGreaterThan(20);
    }
  });

  it("isValidEffortLevel accepts every real level on every model, and still rejects nonsense", () => {
    // "ultra on the default model" is the exact combination that used to 400 in production.
    expect(isValidEffortLevel(DEFAULT_WORKING_MODEL, "low")).toBe(true);
    expect(isValidEffortLevel(DEFAULT_WORKING_MODEL, "high")).toBe(true);
    expect(isValidEffortLevel(DEFAULT_WORKING_MODEL, "ultra")).toBe(true);
    expect(isValidEffortLevel("@cf/openai/gpt-oss-120b", "ultra")).toBe(true);
    expect(isValidEffortLevel(DEFAULT_WORKING_MODEL, "turbo")).toBe(false);
    expect(isValidEffortLevel(DEFAULT_WORKING_MODEL, "")).toBe(false);
  });

  // The whole point of lifting the cap: ultra must actually remove the delegation ceiling on a
  // model that has no thinking mode of its own.
  it("ultra on a non-reasoning model reaches the top delegation tier", () => {
    const ceilingUltra = escalationCeiling(DEFAULT_WORKING_MODEL, "ultra");
    const ceilingLow = escalationCeiling(DEFAULT_WORKING_MODEL, "low");
    expect(ceilingUltra).toBeGreaterThan(ceilingLow);
    // And it still reports no native reasoning param, because the model genuinely has none.
    expect(nativeReasoningForEffort(DEFAULT_WORKING_MODEL, "ultra")).toBeNull();
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

  // Live: a parent running happily on Gemini spawned every sub-agent onto DEFAULT_WORKING_MODEL
  // (Workers AI), whose daily neuron allowance was exhausted — so delegation failed 100% of the
  // time while the parent itself kept working. Both are the same cost tier, so the swap bought
  // nothing and cost everything. The parent's model is the one this run has evidence is reachable.
  it("keeps the PARENT's own model when it is already in the top affordable tier", () => {
    const parent = "google-ai-studio/gemini-3.6-flash";
    const res = resolveEscalationModel(parent, "low");
    expect(res.downgraded).toBe(false);
    expect(res.model).toBe(parent);
    expect(res.model).not.toBe(DEFAULT_WORKING_MODEL);
  });

  it("still ESCALATES when the parent is below the ceiling — preferring the parent must not disable escalation", () => {
    // A cheap parent with a high Effort should move UP, not stay put.
    const res = resolveEscalationModel(DEFAULT_WORKING_MODEL, "ultra");
    expect(costRankForModel(res.model)).toBeGreaterThan(costRankForModel(DEFAULT_WORKING_MODEL));
  });

  it("still DOWNGRADES an expensive parent when Effort is low", () => {
    const res = resolveEscalationModel("@cf/zai-org/glm-5.2" /* premium */, "low");
    expect(costRankForModel(res.model)).toBe(1);
    expect(res.model).not.toBe("@cf/zai-org/glm-5.2");
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

// The capability-matrix fields are transcribed by hand from a real matrix run. A transposed pair
// would render as a confident, meaningless figure on the Discover page — worse than showing
// nothing, because a reader cannot tell it is wrong.
describe("capability-matrix benchmark fields", () => {
  it("every recorded axis result is internally coherent", () => {
    expect(() => validateModelBenchmarks()).not.toThrow();
    for (const b of listModelBenchmarks()) {
      for (const [axis, r] of Object.entries(b.axes ?? {})) {
        expect(r.total, `${b.id}/${axis} total`).toBeGreaterThan(0);
        expect(r.passed, `${b.id}/${axis} passed`).toBeGreaterThanOrEqual(0);
        expect(r.passed, `${b.id}/${axis} passed exceeds total`).toBeLessThanOrEqual(r.total);
      }
    }
  });

  // Cost per RUN is the number that predicts a day of agent work, since one run is many calls.
  // It must only ever be present where genuinely measured — an invented figure here would drive
  // real model-selection decisions.
  it("only records a per-run cost where one was actually measured", () => {
    const withCost = listModelBenchmarks().filter((b) => b.neuronsPerRun !== undefined);
    expect(withCost.length).toBeGreaterThan(0);
    for (const b of withCost) {
      expect(b.neuronsPerRun).toBeGreaterThan(0);
      expect(b.costBasis, `${b.id} claims a measured per-run cost but its cost basis is an estimate`).toBe("measured");
    }
  });
});

// Every op that takes a model needs a way to find out what the real ids ARE — otherwise an agent
// either guesses (and gets a provider 404) or never sets one, which makes per-task model choice
// unusable. agent.list_models is that discovery op; these pin its shape.
describe("agent.list_models — model discovery for ops that take a model", () => {
  it("lists every allowed model with the fields a caller needs to choose one", async () => {
    const { subAgent } = await import("../../../workers/agents/src/script-engine/prebuilt/sub-agent.js");
    const out = (await subAgent.operations["agent.list_models"]!({}, { env: {} as never, run: async () => ({}) })) as {
      default: string;
      models: Array<{ id: string; context_window: number; supports_thinking: boolean; thinking_levels: string[]; cost_tier: string | null }>;
    };

    expect(out.models.length).toBe(ALLOWED_MODELS.length);
    expect(out.default).toBe(DEFAULT_WORKING_MODEL);
    for (const m of out.models) {
      expect(ALLOWED_MODELS).toContain(m.id as (typeof ALLOWED_MODELS)[number]);
      expect(m.context_window).toBeGreaterThan(0);
      // supports_thinking must agree with the levels actually listed — a caller that trusts the
      // boolean and then passes a thinking level would otherwise get a rejection.
      expect(m.supports_thinking).toBe(m.thinking_levels.length > 0);
    }
  });

  it("includes the pinned free-tier Gemini generations, and 3.7 Flash reports a thinking budget", async () => {
    const { subAgent } = await import("../../../workers/agents/src/script-engine/prebuilt/sub-agent.js");
    const out = (await subAgent.operations["agent.list_models"]!({}, { env: {} as never, run: async () => ({}) })) as {
      models: Array<{ id: string; supports_thinking: boolean }>;
    };
    const byId = new Map(out.models.map((m) => [m.id, m]));
    for (const id of [
      "google-ai-studio/gemini-3.7-flash",
      "google-ai-studio/gemini-3.6-flash",
      "google-ai-studio/gemini-3.5-flash",
      "google-ai-studio/gemini-3.5-flash-lite",
    ]) {
      expect(byId.has(id)).toBe(true);
    }
    // Controllable thinking is the whole reason to pin 3.7 rather than ride an alias.
    expect(byId.get("google-ai-studio/gemini-3.7-flash")!.supports_thinking).toBe(true);
  });
});
