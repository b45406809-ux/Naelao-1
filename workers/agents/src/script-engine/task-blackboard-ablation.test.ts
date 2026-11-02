import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type GoalDagJournal, executeGoalDag } from "./goal-dag.js";
import type { GoalTask } from "./prebuilt/goal-planner.js";
import { visibleTaskMessages } from "./task-blackboard.js";

const byteLength = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

function generatedGraphs(seed = 0x4e41454c, count = 100): GoalTask[][] {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  return Array.from({ length: count }, (_, graphIndex) => {
    const count = 3 + Math.floor(random() * 10);
    const tasks: GoalTask[] = [];
    for (let taskIndex = 0; taskIndex < count; taskIndex++) {
      const id = `g${graphIndex}-t${taskIndex}`;
      const dependencies =
        taskIndex === 0
          ? []
          : Array.from({ length: taskIndex }, (_, parent) => parent)
              .filter(() => random() < 0.25)
              .map((parent) => `g${graphIndex}-t${parent}`);
      tasks.push({
        id,
        title: `Produce bounded finding ${id}`,
        subtask_spec: `Return one synthetic finding for ${id}.`,
        assigned_role: "research-worker",
        dependencies,
        file_paths: [`findings/${id}.txt`],
        budget_tokens: 256,
      });
    }
    return tasks;
  });
}

async function run(tasks: GoalTask[], taskBlackboardEnabled: boolean) {
  let journal: GoalDagJournal | undefined;
  const handoffs = new Map<string, unknown[]>();
  const result = await executeGoalDag(tasks, {
    concurrency: 4,
    taskBlackboardEnabled,
    workerId: (id) => `worker:${id}`,
    load: async () => journal && structuredClone(journal),
    save: async (value) => {
      journal = structuredClone(value);
    },
    publish: async () => undefined,
    launch: async (task, workerId, values) => {
      handoffs.set(task.id, structuredClone(values));
      const payload = `finding:${task.id}:${"x".repeat(32 + (task.id.length % 37))}`;
      return { id: workerId, ok: true, output: payload };
    },
    recover: async () => undefined,
  });
  return { journal: result, handoffs };
}

describe("task blackboard ablation experiment", () => {
  it("compares direct dependency handoffs with the production recipient-filtered board on 100 fixed graphs", async () => {
    const startedAt = performance.now();
    const graphs = generatedGraphs();
    const report = {
      schemaVersion: 1,
      kind: "task_blackboard_coordination_ablation",
      evidenceClass: "unit-deterministic-synthetic-graph",
      seed: "0x4e41454c",
      graphs: graphs.length,
      tasks: 0,
      dependencyEdges: 0,
      directHandoffBytes: 0,
      targetedBoardHandoffBytes: 0,
      targetedMessageBytes: 0,
      naiveBroadcastBytes: 0,
      targetedBoardMessages: 0,
      directRequiredInputs: 0,
      targetedBoardRequiredInputs: 0,
      directMissingInputs: 0,
      targetedBoardMissingInputs: 0,
      simulatedDuplicateWorkUnits: 0,
      directTasksWithAllInputs: 0,
      targetedBoardTasksWithAllInputs: 0,
      directVsTargetedPayloadMismatches: 0,
      crossRecipientMessageLeaks: 0,
      completionStatusMismatches: 0,
      elapsedMs: 0,
      byteUnits: "UTF-8 bytes, not model tokens",
      externalProviderCalls: 0,
    };

    for (const tasks of graphs) {
      report.tasks += tasks.length;
      report.dependencyEdges += tasks.reduce(
        (sum, task) => sum + (task.dependencies?.length ?? 0),
        0
      );
      const [direct, targeted] = await Promise.all([
        run(tasks, false),
        run(tasks, true),
      ]);
      const members = new Set(tasks.map((task) => `worker:${task.id}`));
      for (const task of tasks) {
        const expectedDependencies = [...(task.dependencies ?? [])].sort();
        report.directRequiredInputs += expectedDependencies.length;
        report.targetedBoardRequiredInputs += expectedDependencies.length;
        const directValues = direct.handoffs.get(task.id) as Array<{
          taskId: string;
          output: string;
          workerId: string;
          truncated: boolean;
        }>;
        const boardValues = targeted.handoffs.get(task.id) as Array<{
          taskId: string;
          output: string;
          workerId: string;
          truncated: boolean;
        }>;
        if (JSON.stringify(directValues) !== JSON.stringify(boardValues))
          report.directVsTargetedPayloadMismatches++;
        if (
          JSON.stringify(directValues.map((value) => value.taskId).sort()) !==
          JSON.stringify(expectedDependencies)
        )
          report.directVsTargetedPayloadMismatches++;
        const directInputs = new Set(directValues.map((value) => value.taskId));
        const boardInputs = new Set(boardValues.map((value) => value.taskId));
        const missingDirect = expectedDependencies.filter(
          (id) => !directInputs.has(id)
        ).length;
        const missingBoard = expectedDependencies.filter(
          (id) => !boardInputs.has(id)
        ).length;
        report.directMissingInputs += missingDirect;
        report.targetedBoardMissingInputs += missingBoard;
        report.simulatedDuplicateWorkUnits += missingDirect + missingBoard;
        if (missingDirect === 0) report.directTasksWithAllInputs++;
        if (missingBoard === 0) report.targetedBoardTasksWithAllInputs++;
        report.directHandoffBytes += byteLength(directValues);
        report.targetedBoardHandoffBytes += byteLength(boardValues);

        const actor = `worker:${task.id}`;
        const visible = visibleTaskMessages(
          targeted.journal.messages ?? [],
          actor,
          members
        ).filter((message) => message.sender !== actor);
        const visibleIds = visible
          .map((message) => message.id.replace(/^completion:/, ""))
          .sort();
        if (JSON.stringify(visibleIds) !== JSON.stringify(expectedDependencies))
          report.crossRecipientMessageLeaks++;
        report.targetedBoardMessages += visible.length;
        report.targetedMessageBytes += byteLength(
          visible.map((message) => ({ id: message.id, text: message.text }))
        );

        // Counterfactual only: estimate the bytes if every worker received every completion
        // message. This is deliberately not an executable production mode.
        const broadcast = (targeted.journal.messages ?? []).filter(
          (message) => message.sender !== actor
        );
        report.naiveBroadcastBytes += byteLength(
          broadcast.map((message) => ({ id: message.id, text: message.text }))
        );

        if (
          direct.journal.tasks[task.id]?.status !==
            targeted.journal.tasks[task.id]?.status ||
          direct.journal.tasks[task.id]?.status !== "completed"
        )
          report.completionStatusMismatches++;
      }
    }

    report.elapsedMs = Number((performance.now() - startedAt).toFixed(2));
    const reportPath = process.env.NAELAO_BLACKBOARD_ABLATION_REPORT;
    if (reportPath)
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`task_blackboard_ablation=${JSON.stringify(report)}`);

    expect(report.graphs).toBe(100);
    expect(report.tasks).toBeGreaterThanOrEqual(300);
    expect(report.dependencyEdges).toBeGreaterThan(0);
    expect(report.directVsTargetedPayloadMismatches).toBe(0);
    expect(report.crossRecipientMessageLeaks).toBe(0);
    expect(report.completionStatusMismatches).toBe(0);
    expect(report.targetedBoardMessages).toBe(report.dependencyEdges);
    expect(report.targetedBoardHandoffBytes).toBe(report.directHandoffBytes);
    expect(report.directRequiredInputs).toBe(report.dependencyEdges);
    expect(report.targetedBoardRequiredInputs).toBe(report.dependencyEdges);
    expect(report.directMissingInputs).toBe(0);
    expect(report.targetedBoardMissingInputs).toBe(0);
    expect(report.directTasksWithAllInputs).toBe(report.tasks);
    expect(report.targetedBoardTasksWithAllInputs).toBe(report.tasks);
    expect(report.simulatedDuplicateWorkUnits).toBe(0);
    expect(report.naiveBroadcastBytes).toBeGreaterThanOrEqual(
      report.targetedMessageBytes
    );
  });
});
