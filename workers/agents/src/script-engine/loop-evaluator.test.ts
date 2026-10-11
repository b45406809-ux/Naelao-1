import { describe, expect, it, vi } from "vitest";
import { evaluateLoopAfterTool } from "./loop-evaluator.js";

describe("post-tool System One evaluator", () => {
  it("accepts a high-confidence bounded decision", async () => {
    const choice = vi.fn(async () => ({ kind: "choice" as const, value: "MERGE_PR" as const, provider: "laya" as const, policyCode: "post_tool_loop_evaluator_v1", confidence: 0.94 }));
    await expect(evaluateLoopAfterTool({ choice }, { goal: "Create a report", operation: "report.write", ok: true, output: { path: "report.md" }, completedSteps: 2 })).resolves.toMatchObject({ value: "MERGE_PR", provider: "laya" });
  });

  it("ignores low-confidence or failed sentry output", async () => {
    const low = vi.fn(async () => ({ kind: "choice" as const, value: "MERGE_PR" as const, provider: "jev" as const, policyCode: "post_tool_loop_evaluator_v1", confidence: 0.4 }));
    await expect(evaluateLoopAfterTool({ choice: low }, { goal: "Do work", operation: "x", ok: true, completedSteps: 1 })).resolves.toBeNull();
    const failed = vi.fn(async () => { throw new Error("offline"); });
    await expect(evaluateLoopAfterTool({ choice: failed }, { goal: "Do work", operation: "x", ok: false, completedSteps: 1 })).resolves.toBeNull();
  });
});
