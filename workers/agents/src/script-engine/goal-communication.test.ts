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
    const graph: GoalTask[] = Array.from({ length: 12 }, (_, index) => ({ id: `task-${index}`, title: "Task", subtask_spec: "Work", assigned_role: "RESEARCHER", file_paths: [], dependencies: [], budget_tokens: 100 }));
    const allPairs = graph.flatMap((sender, from) => graph.slice(from + 1).map(recipient => ({ senderId: sender.id, recipientId: recipient.id, confidence: 0.9, provider: "openrouter" as const })));
    const capped = applyGoalCommunicationEdges(graph, allPairs);
    expect(capped).toHaveLength(24);
    expect(graph.every(item => (item.communication_recipients?.length ?? 0) <= 8)).toBe(true);
  });

  it("preserves grant, DAG, and fan-out invariants across 1000 seeded adversarial plans", () => {
    let state = 0x51acede;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    let candidateEdges = 0;
    let acceptedEdges = 0;
    let dependencyEdges = 0;

    for (let sample = 0; sample < 1_000; sample++) {
      const count = 2 + Math.floor(random() * 11);
      const graph: GoalTask[] = Array.from({ length: count }, (_, index) => ({
        id: `task-${index}`,
        title: "Generated task",
        subtask_spec: "Untrusted generated task text",
        assigned_role: "RESEARCHER",
        file_paths: [],
        dependencies: [],
        budget_tokens: 100,
      }));
      for (let child = 1; child < count; child++) for (let parent = 0; parent < child; parent++) {
        if (random() < 0.11) graph[child]!.dependencies!.push(`task-${parent}`);
      }
      const proposals: Array<{ senderId: string; recipientId: string; confidence: number; provider: "openrouter" }> = [];
      for (let sender = 0; sender < count; sender++) for (let recipient = 0; recipient < count; recipient++) {
        if (sender === recipient || random() < 0.28) continue;
        proposals.push({ senderId: `task-${sender}`, recipientId: `task-${recipient}`, confidence: random(), provider: "openrouter" });
        if (random() < 0.06) proposals.push({ senderId: `task-${sender}`, recipientId: `task-${recipient}`, confidence: random(), provider: "openrouter" });
      }
      candidateEdges += proposals.length;
      dependencyEdges += graph.reduce((sum, task) => sum + task.dependencies!.length, 0);
      const positions = new Map(graph.map((task, index) => [task.id, index]));
      const hasDependencyPath = (senderId: string, recipientId: string): boolean => {
        const pending = [...(graph.find(task => task.id === recipientId)?.dependencies ?? [])];
        const visited = new Set<string>();
        while (pending.length) {
          const id = pending.pop()!;
          if (id === senderId) return true;
          if (visited.has(id)) continue;
          visited.add(id);
          pending.push(...(graph.find(task => task.id === id)?.dependencies ?? []));
        }
        return false;
      };

      const accepted = applyGoalCommunicationEdges(graph, proposals);
      acceptedEdges += accepted.length;
      expect(accepted.length).toBeLessThanOrEqual(24);
      expect(new Set(accepted.map(edge => `${edge.senderId}\0${edge.recipientId}`)).size).toBe(accepted.length);
      const peerCounts = new Map<string, number>();
      const dependencyChildCounts = new Map<string, number>();
      for (const task of graph) for (const parent of task.dependencies!) dependencyChildCounts.set(parent, (dependencyChildCounts.get(parent) ?? 0) + 1);
      for (const edge of accepted) {
        expect(positions.get(edge.senderId)).toBeLessThan(positions.get(edge.recipientId));
        expect(hasDependencyPath(edge.senderId, edge.recipientId)).toBe(false);
        expect(proposals.some(proposal => proposal.senderId === edge.senderId && proposal.recipientId === edge.recipientId && proposal.confidence >= 0.8)).toBe(true);
        peerCounts.set(edge.senderId, (peerCounts.get(edge.senderId) ?? 0) + 1);
      }
      for (const task of graph) {
        const peers = accepted.filter(edge => edge.senderId === task.id).map(edge => edge.recipientId);
        expect(task.communication_recipients).toEqual(peers);
        expect(new Set(task.communication_recipients).size).toBe(task.communication_recipients!.length);
        expect(peerCounts.get(task.id) ?? 0).toBeLessThanOrEqual(8);
        expect((peerCounts.get(task.id) ?? 0) + (dependencyChildCounts.get(task.id) ?? 0)).toBeLessThanOrEqual(12);
      }
      expect(applyGoalCommunicationEdges(graph, proposals)).toEqual(accepted);
    }

    expect(candidateEdges).toBeGreaterThan(25_000);
    expect(acceptedEdges).toBeGreaterThan(1_000);
    expect(dependencyEdges).toBeGreaterThan(2_500);
    console.log(`goal_communication_fuzz=${JSON.stringify({ seed: "0x51acede", plans: 1_000, candidateEdges, dependencyEdges, acceptedEdges, invariantViolations: 0 })}`);
  });
});
