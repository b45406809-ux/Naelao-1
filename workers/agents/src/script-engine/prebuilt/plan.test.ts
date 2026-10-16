import { describe, expect, it, vi } from "vitest";
import { plan } from "./plan.js";
import { reconstructPlanFromSteps, restorePlanRuntime } from "../loop.js";
import type { PlanState } from "../types.js";

function ctx(planState: PlanState, classifyPlanRuntimes = vi.fn(async ({ steps }: { steps: readonly { id: string }[] }) =>
  steps.map(step => ({ stepId: step.id, capability: "media.ffmpeg", confidence: 0.95 })))) {
  return { env: { plan: planState, classifyPlanRuntimes, activatePlanRuntime: vi.fn(async () => undefined), prewarmPlanRuntime: vi.fn(async () => ({ warmed: true })), planContainerInstallationId: undefined }, commands: new Map(), run: vi.fn() } as never;
}

describe("worker-owned plan board", () => {
  it("batches one System One classification for an edit and keeps runtime transitions deterministic", async () => {
    const state: PlanState = { steps: [] };
    const classify = vi.fn(async ({ steps }: { steps: readonly { id: string }[] }) => steps.map(step => ({ stepId: step.id, capability: "media.ffmpeg", confidence: 0.95 })));
    const context = ctx(state, classify) as Parameters<typeof plan.operations["plan.open_edit"]>[1];
    await plan.operations["plan.open_edit"]!({}, context);
    await plan.operations["plan.set"]!({ steps: ["Edit the video", "Verify the output"] }, context);
    const closed = await plan.operations["plan.close_edit"]!({}, context) as { steps: Array<{ id: string; runtime_capability?: string }>; prewarm_next?: { step_id?: string; capability?: string; warmed?: boolean } };
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0]![0].steps).toHaveLength(2);
    expect(closed.steps[0]?.runtime_capability).toBe("media.ffmpeg");
    expect(closed.prewarm_next).toMatchObject({ step_id: closed.steps[0]?.id, capability: "media.ffmpeg", warmed: true });

    const started = await plan.operations["plan.start_step"]!({ step: closed.steps[0]!.id }, context) as { prewarm_next?: { capability?: string; warmed?: boolean } };
    expect((context.env.activatePlanRuntime as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("media.ffmpeg");
    expect(started.prewarm_next?.warmed).toBe(true);
    expect(classify).toHaveBeenCalledTimes(1);
    await plan.operations["plan.complete_step"]!({ step: closed.steps[0]!.id }, context);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(state.steps[0]?.status).toBe("completed");
  });

  it("restores classified runtime metadata from the recorded edit result without reclassification", () => {
    const steps = [
      { name: "plan.set", params: { steps: ["Render video"] } },
      { name: "plan.close_edit", params: {}, output: { steps: [{ id: "s1-render-video", runtime_capability: "media.ffmpeg", runtime_confidence: 0.95 }] } },
    ];
    expect(reconstructPlanFromSteps(steps).steps[0]).toMatchObject({ runtimeCapability: "media.ffmpeg", runtimeConfidence: 0.95, status: "pending" });
  });

  it("re-resolves the active runtime after replay rather than trusting a stale installation pin", async () => {
    const state = reconstructPlanFromSteps([
      { name: "plan.set", params: { steps: ["Render video"] } },
      { name: "plan.close_edit", params: {}, output: { steps: [{ id: "s1-render-video", runtime_capability: "media.ffmpeg", runtime_confidence: 0.95 }] } },
      { name: "plan.start_step", params: { step: "s1-render-video" } },
    ]);
    const activate = vi.fn(async () => undefined);
    await restorePlanRuntime(state, activate);
    expect(activate).toHaveBeenCalledWith("media.ffmpeg");
  });

  it("does not change runtime pins for an invalid out-of-order start", async () => {
    const state: PlanState = { editing: true, steps: [{ id: "one", text: "one", done: false }, { id: "two", text: "two", done: false }] };
    const context = ctx(state) as Parameters<typeof plan.operations["plan.start_step"]>[1];
    const activate = context.env.activatePlanRuntime as ReturnType<typeof vi.fn>;
    const result = await plan.operations["plan.start_step"]!({ step: "two" }, context) as { ok: boolean; error: string };
    expect(result).toMatchObject({ ok: false, error: "close_plan_edit_before_starting_work" });
    expect(activate).not.toHaveBeenCalled();
  });
});
