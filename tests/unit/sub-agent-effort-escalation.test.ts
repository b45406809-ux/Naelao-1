import { describe, it, expect } from "vitest";
import { DEFAULT_WORKING_MODEL, costRankForModel, escalationCeiling } from "@naelao/billing-core";
import { resolveWorkerModel, selectWorkerModel } from "../../workers/agents/src/script-engine/worker-model-routing.js";

describe("sub-agent model selection follows the parent effort policy", () => {
  it("does not let a planner-authored child model exceed a low effort ceiling", () => {
    const plannerModel = "claude-opus-4-8";
    const requestedChildModel = "@cf/zai-org/glm-5.2";
    const resolution = resolveWorkerModel({ plannerModel, contextAffinity: "shared", effort: "low" });

    expect(resolution.downgraded).toBe(true);
    expect(costRankForModel(resolution.model)).toBeLessThanOrEqual(escalationCeiling(plannerModel, "low"));
    expect(resolution.model).not.toBe(requestedChildModel);
  });

  it("keeps isolated bulk work on the runtime-selected model even if planner task data names one", () => {
    const resolution = resolveWorkerModel({
      plannerModel: "openai/gpt-6-luna",
      contextAffinity: "isolated",
      effort: "low",
    });
    expect(resolution.model).toBe(DEFAULT_WORKING_MODEL);
  });

  it("rejects decision-model suggestions outside the runtime-filtered candidates", async () => {
    const result = await selectWorkerModel({
      plannerModel: "claude-sonnet-4-6",
      contextAffinity: "isolated",
      effort: "low",
      goal: "summarize a bounded research result",
    }, {
      choice: async () => ({ kind: "choice", value: "claude-opus-4-8", provider: "openrouter", policyCode: "test" }) as never,
    });
    expect(result.model).toBe(DEFAULT_WORKING_MODEL);
  });
});
