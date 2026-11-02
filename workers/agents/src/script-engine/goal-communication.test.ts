import { describe, expect, it } from "vitest";
import { applyGoalCommunicationEdges } from "./goal-communication.js";
import type { GoalTask } from "./prebuilt/goal-planner.js";

const tasks = (): GoalTask[] => [
  { id: "research", title: "Research", subtask_spec: "Gather sources", assigned_role: "RESEARCHER", file_paths: [], dependencies: [], budget_tokens: 100 },
  { id: "check", title: "Check", subtask_spec: "Check sources", assigned_role: "REVIEWER", file_paths: [], dependencies: ["research"], budget_tokens: 100 },
  { id: "synthesize", title: "Synthesize", subtask_spec: "Write synthesis", assigned_role: "WRITER", file_paths: [], dependencies: [], budget_tokens: 100 },
];

describe("host selected task communication", () => {
  it("applies only valid, confident, non-redundant forward edges", () => {
    const plan = tasks();
    const edges = applyGoalCommunicationEdges(plan, [
      { senderId: "research", recipientId: "check", confidence: 0.99, provider: "openrouter" }, // existing dependency
      { senderId: "research", recipientId: "synthesize", confidence: 0.91, provider: "openrouter" },
      { senderId: "synthesize", recipientId: "research", confidence: 1, provider: "openrouter" }, // backwards
      { senderId: "check", recipientId: "synthesize", confidence: 0.79, provider: "openrouter" },
    ]);
    expect(edges).toEqual([{ senderId: "research", recipientId: "synthesize" }]);
    expect(plan[0]?.communication_recipients).toEqual(["synthesize"]);
    expect(plan[1]?.communication_recipients).toEqual([]);
    expect(plan[2]?.dependencies).toEqual([]);
  });

  it("fails closed on malformed model output and keeps peer fan-out bounded", () => {
    const plan = tasks();
    expect(() => applyGoalCommunicationEdges(plan, [{ senderId: "research", recipientId: "check", confidence: Number.NaN, provider: "openrouter" }])).toThrow("goal_communication_proposals_invalid");
    const fanout = tasks();
    for (let index = 0; index < 9; index++) fanout.push({ id: `peer-${index}`, title: "Peer", subtask_spec: "Read", assigned_role: "RESEARCHER", file_paths: [], dependencies: [], budget_tokens: 100 });
    const applied = applyGoalCommunicationEdges(fanout, fanout.slice(1).map(task => ({ senderId: "research", recipientId: task.id, confidence: 0.9, provider: "openrouter" })));
    expect(applied).toHaveLength(8);
    expect(fanout[0]?.communication_recipients).toHaveLength(8);
    const mixed: GoalTask[] = [{ id: "source", title: "Source", subtask_spec: "Read", assigned_role: "RESEARCHER", file_paths: [], dependencies: [], budget_tokens: 100 }];
    for (let index = 0; index < 9; index++) mixed.push({ id: `dependent-${index}`, title: "Dependent", subtask_spec: "Use source", assigned_role: "RESEARCHER", file_paths: [], dependencies: ["source"], budget_tokens: 100 });
    mixed.push({ id: "peer-a", title: "Peer A", subtask_spec: "Read", assigned_role: "RESEARCHER", file_paths: [], dependencies: [], budget_tokens: 100 });
    mixed.push({ id: "peer-b", title: "Peer B", subtask_spec: "Read", assigned_role: "RESEARCHER", file_paths: [], dependencies: [], budget_tokens: 100 });
    const mixedEdges = applyGoalCommunicationEdges(mixed, ["peer-a", "peer-b"].map(recipientId => ({ senderId: "source", recipientId, confidence: 0.9, provider: "openrouter" as const })));
    expect(mixedEdges).toHaveLength(2);
    expect(mixed[0]?.communication_recipients).toHaveLength(2);
    expect(mixedEdges.length + 9).toBeLessThanOrEqual(12); // The DAG's 12-task ceiling bounds the complete recipient set.
  });
});
