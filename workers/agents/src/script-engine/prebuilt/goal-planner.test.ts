import { describe, expect, it, vi } from "vitest";
import { goalPlanner, type GoalTask } from "./goal-planner.js";

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `Task ${id}`, subtask_spec: `Complete ${id}`, assigned_role: "DEV_OPERATOR", file_paths: [], ...extra,
});

function harness(depth: 1 | 2, budget: number) {
  const executeGoalDag = vi.fn(async (_objective: string, tasks: GoalTask[]) => ({
    tasks: Object.fromEntries(tasks.map(item => [item.id, { status: "completed", workerId: item.id }])),
  }));
  const env = { workerTokenBudget: budget, delegationDepth: depth, delegationPlanner: true,
    orchestration: { persistGoalTasks: vi.fn(async () => undefined), spawnSubAgent: vi.fn(async () => ({ id: "unused" })), executeGoalDag } };
  const run = (tasks: unknown[]) => goalPlanner.operations["engine.plan_and_delegate_goal"]!({ objective: "bounded plan", tasks }, {
    env: env as never, run: vi.fn(),
  });
  return { executeGoalDag, run };
}

describe("goal planner hierarchy limits", () => {
  it("splits a nested planner's inherited worker-token pool across omitted task budgets", async () => {
    const h = harness(2, 1_000);
    await h.run([task("a"), task("b"), task("c")]);
    const planned = h.executeGoalDag.mock.calls[0]![1];
    expect(planned.map(item => item.budget_tokens)).toEqual([333, 333, 333]);
    expect(planned.reduce((sum, item) => sum + item.budget_tokens, 0)).toBeLessThanOrEqual(1_000);
  });

  it("rejects nested sibling allocations above the inherited task budget", async () => {
    const h = harness(2, 1_000);
    await expect(h.run([task("a", { budget_tokens: 600 }), task("b", { budget_tokens: 500 })]))
      .rejects.toThrow("goal_plan_budget_exceeded");
    expect(h.executeGoalDag).not.toHaveBeenCalled();
  });

  it("allows at most four planner children at the root and forbids a third planner level", async () => {
    const root = harness(1, 1_000);
    await expect(root.run(Array.from({ length: 5 }, (_, index) => task(`planner-${index}`, { planner: true }))))
      .rejects.toThrow("goal_plan_planner_fanout_exceeded");
    expect(root.executeGoalDag).not.toHaveBeenCalled();

    const nested = harness(2, 1_000);
    await expect(nested.run([task("too-deep", { planner: true })])).rejects.toThrow("goal_plan_depth_exceeded");
    expect(nested.executeGoalDag).not.toHaveBeenCalled();
  });

  it("preserves explicitly declared alternative groups and rejects non-string labels", async () => {
    const h = harness(1, 1_000);
    await h.run([task("a", { redundancy_group: "lookup" }), task("b", { redundancy_group: "lookup" })]);
    expect(h.executeGoalDag.mock.calls[0]![1].map(item => item.redundancy_group)).toEqual(["lookup", "lookup"]);

    const invalid = harness(1, 1_000);
    await expect(invalid.run([task("a", { redundancy_group: 5 }), task("b", { redundancy_group: 5 })]))
      .rejects.toThrow("invalid redundancy_group");
    expect(invalid.executeGoalDag).not.toHaveBeenCalled();
  });
});
