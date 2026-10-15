import { describe, expect, it } from "vitest";
import { DEFAULT_WORKING_MODEL } from "@naelao/billing-core";
import { resolveWorkerModel } from "./worker-model-routing.js";

describe("automatic worker model routing", () => {
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
