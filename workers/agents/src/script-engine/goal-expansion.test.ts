import { describe, expect, it } from "vitest";
import { GOAL_EXPANSION_OUTPUT_KEY, prepareGoalExpansion, readGoalExpansionProposal } from "./goal-expansion.js";
import { type GoalTask } from "./prebuilt/goal-planner.js";

const parent: GoalTask = {
  id: "audit", title: "Audit", subtask_spec: "Audit the change", assigned_role: "schema-validator",
  agent_id: "worker-a", planner: true, context_affinity: "shared", file_paths: ["src/a.ts", "src/b.ts"],
  dependencies: [], budget_tokens: 1200, decision_refs: [{ id: "decision-1", revision: 3 }],
  runtime_capability: "node", runtime_resource_key: "runtime.node." + "a".repeat(40), resource_keys: ["project.container"], priority: 2,
};

const proposal = (tasks: unknown[]) => ({ [GOAL_EXPANSION_OUTPUT_KEY]: { version: 1, tasks } });

describe("host-bounded goal expansion", () => {
  it("recognizes only the explicit structured control field", () => {
    expect(readGoalExpansionProposal({ text: "more work" })).toBeUndefined();
    expect(readGoalExpansionProposal(JSON.stringify(proposal([])))).toBeUndefined();
    expect(readGoalExpansionProposal(proposal([{ id: "check" }]))).toEqual([{ id: "check" }]);
    expect(() => readGoalExpansionProposal({ [GOAL_EXPANSION_OUTPUT_KEY]: { version: 2, tasks: [] } })).toThrow("invalid_goal_expansion_proposal");
  });

  it("creates stable, parent-scoped children and preserves only host-derived authority", async () => {
    const candidates = [
      { id: "inspect", title: "Inspect", subtask_spec: "Inspect the relevant behavior", file_paths: ["src/a.ts"], budget_tokens: 300 },
      { id: "verify", title: "Verify", subtask_spec: "Verify the outcome", dependencies: ["inspect"], budget_tokens: 200 },
    ];
    const first = await prepareGoalExpansion({ parent, existingTasks: [parent], proposedTasks: candidates, remainingBudgetTokens: 500 });
    const again = await prepareGoalExpansion({ parent, existingTasks: [parent], proposedTasks: candidates, remainingBudgetTokens: 500 });
    expect(first.proposalId).toBe(again.proposalId);
    expect(first.tasks.map(task => task.id)).toEqual(again.tasks.map(task => task.id));
    expect(first.tasks[0]).toMatchObject({
      assigned_role: parent.assigned_role, agent_id: parent.agent_id, planner: false, file_paths: ["src/a.ts"],
      dependencies: ["audit"], decision_refs: parent.decision_refs, runtime_capability: parent.runtime_capability,
      resource_keys: parent.resource_keys, priority: parent.priority, budget_tokens: 300, expansion_depth: 1,
    });
    expect(first.tasks[1]).toMatchObject({ dependencies: [first.tasks[0]!.id], budget_tokens: 200, expansion_depth: 1 });
    expect(first.tasks[0]).not.toHaveProperty("communication_recipients");
  });

  it("rejects authority changes, scope broadening, invalid graphs and budget oversubscription", async () => {
    const valid = { id: "check", title: "Check", subtask_spec: "Check", budget_tokens: 100 };
    await expect(prepareGoalExpansion({ parent, existingTasks: [parent], proposedTasks: [{ ...valid, agent_id: "other" }], remainingBudgetTokens: 100 }))
      .rejects.toThrow("goal_expansion_authority_field_denied");
    await expect(prepareGoalExpansion({ parent, existingTasks: [parent], proposedTasks: [{ ...valid, file_paths: ["secrets.env"] }], remainingBudgetTokens: 100 }))
      .rejects.toThrow("goal_expansion_file_boundary_exceeded");
    await expect(prepareGoalExpansion({ parent, existingTasks: [parent], proposedTasks: [
      { ...valid, id: "a", dependencies: ["b"] }, { ...valid, id: "b", dependencies: ["a"] },
    ], remainingBudgetTokens: 200 })).rejects.toThrow("cycle");
    await expect(prepareGoalExpansion({ parent, existingTasks: [parent], proposedTasks: [
      { ...valid, id: "a", budget_tokens: 70 }, { ...valid, id: "b", budget_tokens: 50 },
    ], remainingBudgetTokens: 100 })).rejects.toThrow("goal_expansion_budget_exceeded");
    await expect(prepareGoalExpansion({ parent, existingTasks: [parent], proposedTasks: [valid], remainingBudgetTokens: 0 }))
      .rejects.toThrow("goal_expansion_budget_exhausted");
  });

  it("rejects nested expansion and additions beyond the graph ceiling", async () => {
    await expect(prepareGoalExpansion({ parent: { ...parent, expansion_depth: 1 }, existingTasks: [parent], proposedTasks: [{ id: "check", title: "Check", subtask_spec: "Check" }], remainingBudgetTokens: 100 }))
      .rejects.toThrow("goal_expansion_depth_exceeded");
    const fullGraph = [parent, ...Array.from({ length: 11 }, (_, index) => ({ ...parent, id: `t${index}`, title: `t${index}` }))];
    await expect(prepareGoalExpansion({ parent, existingTasks: fullGraph, proposedTasks: [{ id: "check", title: "Check", subtask_spec: "Check" }], remainingBudgetTokens: 100 }))
      .rejects.toThrow("goal_expansion_graph_limit_exceeded");
  });
});
