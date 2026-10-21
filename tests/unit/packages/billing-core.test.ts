import { describe, it, expect } from "vitest";
import {
  computeTokenCostMicro, tokensToCredits, CREDITS_PER_USD, contextWindowForModel, MODEL_CONTEXT_WINDOWS,
  capabilityForModel, isValidReasoningLevel, ALLOWED_MODELS, MODEL_CAPABILITIES,
  PERSONAL_PLAN_LIMITS, isPersonalPlanTier, resolveEffectiveBusinessLimit, canPersonalPlanInvite,
  UTILITY_MODEL, DEFAULT_WORKING_MODEL, capabilityForModel as capFor,
} from "@naelao/billing-core";

describe("UTILITY_MODEL — cascaded-routing cheap tier (token trick 4)", () => {
  it("is a real, allowed model", () => {
    expect(ALLOWED_MODELS).toContain(UTILITY_MODEL);
  });
  it("has a known context window (not the fallback default)", () => {
    // A model the engine routes utility work to must be in the real capability tables.
    expect(MODEL_CONTEXT_WINDOWS[UTILITY_MODEL]).toBeGreaterThan(0);
    expect(capFor(UTILITY_MODEL)).toBeDefined();
  });
  it("is distinct from the reasoning default — utility work must not burn the reasoning model", () => {
    expect(UTILITY_MODEL).not.toBe(DEFAULT_WORKING_MODEL);
  });
});

describe("computeTokenCostMicro — per-model USD pricing", () => {
  it("prices a known model's input/output tokens separately", () => {
    // claude-haiku-4-5-20251001: input $0.25/1M, output $1.25/1M
    const micro = computeTokenCostMicro(1_000_000, 1_000_000, "claude-haiku-4-5-20251001");
    expect(micro).toBe(Math.round((0.25 + 1.25) * 1_000_000));
  });

  it("falls back to a default rate for an unknown model", () => {
    const known = computeTokenCostMicro(1000, 1000, "claude-sonnet-4-6");
    const unknown = computeTokenCostMicro(1000, 1000, "some-future-model");
    expect(unknown).toBe(known);
  });
});

describe("tokensToCredits — the ONLY place tokens become the platform credit unit", () => {
  it("converts a real (non-zero) cost to at least 1 credit, never silently free", () => {
    // A single cheap Haiku turn — a tiny fraction of a cent in raw USD.
    const credits = tokensToCredits(50, 50, "claude-haiku-4-5-20251001");
    expect(credits).toBeGreaterThanOrEqual(1);
  });

  it("returns 0 credits for zero token usage", () => {
    expect(tokensToCredits(0, 0, "claude-haiku-4-5-20251001")).toBe(0);
  });

  it("charges more for a pricier model given the same token counts", () => {
    const haiku = tokensToCredits(100_000, 100_000, "claude-haiku-4-5-20251001");
    const opus = tokensToCredits(100_000, 100_000, "claude-opus-4-8");
    expect(opus).toBeGreaterThan(haiku);
  });

  it("is consistent with computeTokenCostMicro under CREDITS_PER_USD", () => {
    const micro = computeTokenCostMicro(500_000, 200_000, "claude-sonnet-4-6");
    const credits = tokensToCredits(500_000, 200_000, "claude-sonnet-4-6");
    expect(credits).toBe(Math.max(1, Math.ceil((micro * 1.15 * CREDITS_PER_USD) / 1_000_000)));
  });
});

describe("contextWindowForModel — §A1.27 per-model context window lookup", () => {
  it("returns a real window size for every known model", () => {
    for (const model of Object.keys(MODEL_CONTEXT_WINDOWS)) {
      expect(contextWindowForModel(model)).toBeGreaterThan(0);
    }
  });

  it("degrades to a sane documented default for an unknown model rather than throwing", () => {
    expect(() => contextWindowForModel("some-future-model")).not.toThrow();
    expect(contextWindowForModel("some-future-model")).toBeGreaterThan(0);
  });
});

// The model switcher's capability-aware config card: which of ALLOWED_MODELS support a
// configurable reasoning-effort/thinking mode, and what levels/wire shape to use.
describe("MODEL_CAPABILITIES / capabilityForModel — reasoning-effort capability registry", () => {
  it("has a registry entry for every allowed model — none silently missing", () => {
    for (const model of ALLOWED_MODELS) {
      expect(MODEL_CAPABILITIES[model]).toBeDefined();
    }
  });

  it("the account's actual working default (Llama 3.3) correctly has NO reasoning control — it isn't a reasoning model", () => {
    const cap = capabilityForModel("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(cap.reasoningParam).toBe("none");
    expect(cap.reasoningLevels).toEqual([]);
  });

  it("gpt-oss models offer the OpenAI-style low/medium/high reasoning_effort levels", () => {
    const cap = capabilityForModel("@cf/openai/gpt-oss-120b");
    expect(cap.reasoningParam).toBe("reasoning_effort");
    expect(cap.reasoningLevels).toEqual(["low", "medium", "high"]);
  });

  it("Kimi K2.6 uses its own kimi_thinking shape (an on/off toggle), not reasoning_effort", () => {
    const cap = capabilityForModel("@cf/moonshotai/kimi-k2.6");
    expect(cap.reasoningParam).toBe("kimi_thinking");
    expect(cap.reasoningLevels).toEqual(["off", "on"]);
  });

  it("degrades to no-reasoning for an unknown model string rather than throwing", () => {
    expect(() => capabilityForModel("some-future-model")).not.toThrow();
    expect(capabilityForModel("some-future-model").reasoningParam).toBe("none");
  });

  it("isValidReasoningLevel accepts only a level the model actually offers", () => {
    expect(isValidReasoningLevel("@cf/openai/gpt-oss-120b", "high")).toBe(true);
    expect(isValidReasoningLevel("@cf/openai/gpt-oss-120b", "max")).toBe(false); // that's glm-5.2's level, not this model's
    expect(isValidReasoningLevel("@cf/zai-org/glm-5.2", "max")).toBe(true);
    expect(isValidReasoningLevel("@cf/meta/llama-3.3-70b-instruct-fp8-fast", "high")).toBe(false);
  });
});

describe("personal-plan (Phase 4, money) — resolveEffectiveBusinessLimit / canPersonalPlanInvite", () => {
  it("isPersonalPlanTier accepts only the two real tiers", () => {
    expect(isPersonalPlanTier("free")).toBe(true);
    expect(isPersonalPlanTier("plus")).toBe(true);
    expect(isPersonalPlanTier("enterprise")).toBe(false);
    expect(isPersonalPlanTier(undefined)).toBe(false);
    expect(isPersonalPlanTier(null)).toBe(false);
  });

  it("a free-tier user's effective limit is the SMALLER of the product ceiling and the free-tier cap", () => {
    // free cap is 3 — a product allowing 10 still squeezes a free user down to 3.
    expect(resolveEffectiveBusinessLimit("free", 10)).toBe(PERSONAL_PLAN_LIMITS.free.maxBusinessesOwned);
    expect(resolveEffectiveBusinessLimit("free", 10)).toBe(3);
  });

  it("a free-tier user is never squeezed BELOW a product ceiling that's already smaller than the free cap", () => {
    // A builder set maxBusinessesPerEndUser=1 — the personal plan must never claim MORE than that.
    expect(resolveEffectiveBusinessLimit("free", 1)).toBe(1);
  });

  it("a 'plus' user gets the FULL product ceiling, never capped by the free-tier number", () => {
    expect(resolveEffectiveBusinessLimit("plus", 10)).toBe(10);
    expect(resolveEffectiveBusinessLimit("plus", 999)).toBe(999);
  });

  it("canPersonalPlanInvite: only 'plus' may invite others", () => {
    expect(canPersonalPlanInvite("free")).toBe(false);
    expect(canPersonalPlanInvite("plus")).toBe(true);
  });
});
