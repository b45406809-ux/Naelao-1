import { describe, expect, it } from "vitest";
import { DEFAULT_WORKING_MODEL, OPENROUTER_WORKING_MODEL } from "@naelao/billing-core";
import { resolveWorkerModel, selectWorkerModel, isWorkerPriceAllowed } from "./worker-model-routing.js";

describe("automatic worker model routing", () => {
  it("rejects missing or increased live prices for the pinned economy worker", () => {
    expect(isWorkerPriceAllowed(OPENROUTER_WORKING_MODEL, undefined)).toBe(false);
    expect(isWorkerPriceAllowed(OPENROUTER_WORKING_MODEL, { inputUsdPerToken: 0.05 / 1_000_000, outputUsdPerToken: 0.6 / 1_000_000 })).toBe(true);
    expect(isWorkerPriceAllowed(OPENROUTER_WORKING_MODEL, { inputUsdPerToken: 1 / 1_000_000, outputUsdPerToken: 3 / 1_000_000 })).toBe(false);
  });
  it("chooses the economy DeepSeek snapshot for an OpenRouter worker without switching payer/provider", () => {
    expect(resolveWorkerModel({ plannerModel: "openrouter/vendor/expensive-planner", effort: "low", contextAffinity: "shared" }).model).toBe(OPENROUTER_WORKING_MODEL);
  });
  it("rejects a System One suggestion outside its host-filtered effort candidates", async () => {
    const result = await selectWorkerModel({ plannerModel: "claude-sonnet-4-6", effort: "medium", contextAffinity: "isolated", goal: "simple lookup" }, {
      choice: async () => ({ kind: "choice", value: "claude-opus-4-8", provider: "clef", policyCode: "test" }) as never,
    });
    expect(result.model).toBe(DEFAULT_WORKING_MODEL);
  });
  it("keeps state-tethered work on the planner's verified model within the effort ceiling", () => {
    expect(resolveWorkerModel({
      plannerModel: DEFAULT_WORKING_MODEL,
      contextAffinity: "shared",
      effort: "medium",
    })).toMatchObject({ model: DEFAULT_WORKING_MODEL, downgraded: false });
  });

  it("routes isolated work to the known platform model, not a planner-authored model id", () => {
    expect(resolveWorkerModel({
      plannerModel: "openai/gpt-6-luna",
      contextAffinity: "isolated",
      effort: "ultra",
    })).toMatchObject({ model: DEFAULT_WORKING_MODEL, downgraded: false });
  });

  it("reduces a costly shared-context model when the selected effort ceiling is low", () => {
    const result = resolveWorkerModel({ plannerModel: "claude-opus-4-8", contextAffinity: "shared", effort: "low" });
    expect(result.downgraded).toBe(true);
    expect(result.model).not.toBe("claude-opus-4-8");
  });

  it("retains local and private routes rather than falling back to cloud", () => {
    expect(resolveWorkerModel({ plannerModel: "local/qwen-coder", contextAffinity: "isolated", effort: "low" })).toMatchObject({
      model: "local/qwen-coder", downgraded: false,
    });
    expect(resolveWorkerModel({ plannerModel: "openrouter/vendor/model", contextAffinity: "isolated", effort: "low", privateRoute: true })).toMatchObject({
      model: "openrouter/vendor/model", downgraded: false,
    });
  });
});
