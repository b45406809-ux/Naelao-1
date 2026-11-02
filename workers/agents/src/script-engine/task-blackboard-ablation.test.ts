import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type GoalDagJournal, executeGoalDag } from "./goal-dag.js";
import type { GoalTask } from "./prebuilt/goal-planner.js";
import { visibleTaskMessages } from "./task-blackboard.js";

const byteLength = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const estimateTokens = (value: unknown) => Math.ceil(byteLength(value) / 4);

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

  it("compares a direct duplicate lookup with a peer reusing a completion message", async () => {
    const expected = "customs duty rate is 15 percent";
    const tasks: GoalTask[] = [
      {
        id: "lookup",
        title: "Find duty rate",
        subtask_spec: "Find the customs duty rate in the approved fixture.",
        assigned_role: "research-worker",
        file_paths: [],
        dependencies: [],
        communication_recipients: ["reuse"],
        budget_tokens: 128,
      },
      {
        id: "reuse",
        title: "Answer using shared finding",
        subtask_spec: "Use a peer finding if one is shared; otherwise perform the same lookup.",
        assigned_role: "research-worker",
        file_paths: [],
        dependencies: [],
        budget_tokens: 128,
      },
    ];

    const executeArm = async (taskBlackboardEnabled: boolean) => {
      let journal: GoalDagJournal | undefined;
      let fixtureLookups = 0;
      let completionAvailableAtRecipientLaunch = false;
      const result = await executeGoalDag(tasks, {
        concurrency: 2,
        taskBlackboardEnabled,
        workerId: (id) => `worker:${id}`,
        load: async () => journal && structuredClone(journal),
        save: async (snapshot) => { journal = structuredClone(snapshot); },
        publish: async () => undefined,
        recover: async () => undefined,
        launch: async (task, workerId) => {
          if (task.id === "lookup") {
            fixtureLookups++;
            return { id: workerId, ok: true, output: expected };
          }
          if (taskBlackboardEnabled) {
            const messages = visibleTaskMessages(
              journal?.messages ?? [],
              workerId,
              new Set(["worker:lookup", "worker:reuse"])
            );
            const completion = messages.find((message) => message.id === "completion:lookup");
            completionAvailableAtRecipientLaunch = Boolean(completion);
            if (completion) {
              const reused = JSON.parse(completion.text) as { output: string };
              return {
                id: workerId,
                ok: true,
                output: JSON.parse(reused.output) as string,
              };
            }
          }
          fixtureLookups++;
          return { id: workerId, ok: true, output: expected };
        },
      });
      return {
        taskBlackboardEnabled,
        lookupCalls: fixtureLookups,
        duplicateLookupCalls: Math.max(0, fixtureLookups - 1),
        messages: result.messages?.length ?? 0,
        completionAvailableAtRecipientLaunch,
        outcomes: Object.fromEntries(
          Object.entries(result.tasks).map(([id, state]) => [id, state.result?.output])
        ),
        allTasksCompleted: Object.values(result.tasks).every((state) => state.status === "completed"),
      };
    };

    const [direct, shared] = await Promise.all([executeArm(false), executeArm(true)]);
    const report = {
      schemaVersion: 1,
      kind: "matched_peer_reuse_synthetic_workload",
      evidenceClass: "unit-deterministic-synthetic-worker-action",
      taskCount: tasks.length,
      dependencyEdges: 0,
      expectedResult: expected,
      direct,
      blackboard: shared,
      outcomeMismatch: JSON.stringify(direct.outcomes) !== JSON.stringify(shared.outcomes),
      externalProviderCalls: 0,
      automaticRecipientWake: shared.completionAvailableAtRecipientLaunch,
      limitations: ["The worker action is a deterministic fixture lookup, not a model/tool provider call; peer routing was injected as a fixture rather than selected by a live Decisions model."],
    };
    const reportPath = process.env.NAELAO_BLACKBOARD_PEER_REPORT;
    if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`task_blackboard_peer_reuse=${JSON.stringify(report)}`);

    expect(direct.allTasksCompleted).toBe(true);
    expect(shared.allTasksCompleted).toBe(true);
    expect(direct.outcomes).toEqual(shared.outcomes);
    expect(direct.duplicateLookupCalls).toBe(1);
    expect(shared.duplicateLookupCalls).toBe(0);
    expect(shared.completionAvailableAtRecipientLaunch).toBe(true);
    expect(direct.messages).toBe(0);
    expect(shared.messages).toBe(1);
    expect(report.outcomeMismatch).toBe(false);
  });

  it("compares no-board, targeted-board, and broadcast coordination on matched verified tasks", async () => {
    // Keep the real GoalDag under both its 12-task and 8-recipient host ceilings.
    const groups = 2;
    const consumersPerGroup = 3;
    const repeats = 3;
    const tasks: GoalTask[] = [];
    const expectedByTask = new Map<string, string>();
    for (let group = 0; group < groups; group++) {
      const source = `g${group}-source`;
      const expected = `verified finding ${group}: source value ${100 + group}`;
      expectedByTask.set(source, expected);
      const consumers = Array.from({ length: consumersPerGroup }, (_, index) => `g${group}-consumer-${index}`);
      tasks.push({
        id: source,
        title: `Read source value for group ${group}`,
        subtask_spec: `Retrieve and report the approved fixture value for group ${group}.`,
        assigned_role: "research-worker",
        file_paths: [],
        dependencies: [],
        communication_recipients: consumers.slice(0, 2),
        budget_tokens: 128,
      });
      for (let index = 0; index < consumersPerGroup; index++) {
        const id = consumers[index]!;
        expectedByTask.set(id, expected);
        tasks.push({
          id,
          title: `Answer using group ${group} source value`,
          subtask_spec: `Report the approved fixture value for group ${group}; reuse a visible peer finding when available.`,
          assigned_role: "research-worker",
          file_paths: [],
          dependencies: [],
          budget_tokens: 128,
        });
      }
    }

    const runArm = async (mode: "no_board" | "targeted" | "broadcast") => {
      const armTasks = structuredClone(tasks);
      if (mode === "broadcast") {
        for (const task of armTasks) {
          if (task.id.endsWith("-source"))
            task.communication_recipients = armTasks.filter(candidate => !candidate.id.endsWith("-source")).map(candidate => candidate.id);
        }
      }
      let journal: GoalDagJournal | undefined;
      let workerModelCalls = 0;
      let workerInputTokensEstimated = 0;
      let workerOutputTokensEstimated = 0;
      let fixtureLookups = 0;
      const started = performance.now();
      const result = await executeGoalDag(armTasks, {
        concurrency: 4,
        taskBlackboardEnabled: mode !== "no_board",
        workerId: id => `worker:${id}`,
        load: async () => journal && structuredClone(journal),
        save: async snapshot => { journal = structuredClone(snapshot); },
        publish: async () => undefined,
        recover: async () => undefined,
        verify: async (task, workerResult) => {
          const passed = workerResult.output === expectedByTask.get(task.id);
          return { outcome: passed ? "passed" : "failed", reason: passed ? "Fixture output matched expected task result." : "Fixture output did not match expected task result." };
        },
        launch: async (task, workerId, handoffs) => {
          workerModelCalls++;
          const members = new Set(armTasks.map(candidate => `worker:${candidate.id}`));
          const visible = mode === "no_board" ? [] : visibleTaskMessages(journal?.messages ?? [], workerId, members);
          const promptShape = { task: { id: task.id, title: task.title, subtask_spec: task.subtask_spec }, handoffs, visibleMessages: visible.map(({ sender, kind, text }) => ({ sender, kind, text })) };
          workerInputTokensEstimated += estimateTokens(promptShape);
          const expected = expectedByTask.get(task.id)!;
          let output: string;
          if (task.id.endsWith("-source")) {
            fixtureLookups++;
            // Keep the simulated external lookup latency explicit and identical in every arm.
            await new Promise(resolve => setTimeout(resolve, 2));
            output = expected;
          } else {
            const groupPrefix = task.id.split("-").slice(0, 1).join("-");
            const message = visible.find(item => item.id === `completion:${groupPrefix}-source`);
            if (message) {
              const decoded = JSON.parse(message.text) as { output: string };
              output = JSON.parse(decoded.output) as string;
            } else {
              fixtureLookups++;
              await new Promise(resolve => setTimeout(resolve, 2));
              output = expected;
            }
          }
          workerOutputTokensEstimated += estimateTokens(output);
          return { id: workerId, ok: true, output };
        },
      });
      const elapsedMs = Number((performance.now() - started).toFixed(2));
      const completed = Object.values(result.tasks).filter(state => state.status === "completed").length;
      const verificationsPassed = Object.values(result.tasks).filter(state => state.verification?.outcome === "passed").length;
      const groupCount = groups;
      const duplicateLookupCalls = Math.max(0, fixtureLookups - groupCount);
      const messages = result.messages ?? [];
      return {
        mode,
        elapsedMs,
        completedTasks: completed,
        verifiedTasks: verificationsPassed,
        workerModelCalls,
        workerInputTokensEstimated,
        workerOutputTokensEstimated,
        totalTokensEstimated: workerInputTokensEstimated + workerOutputTokensEstimated,
        fixtureLookupCalls: fixtureLookups,
        duplicateLookupCalls,
        boardMessages: messages.length,
        visibleMessageBytesAcrossWorkers: armTasks.reduce((sum, task) => {
          if (mode === "no_board") return sum;
          const visible = visibleTaskMessages(messages, `worker:${task.id}`, new Set(armTasks.map(candidate => `worker:${candidate.id}`)));
          return sum + byteLength(visible.map(({ id, text }) => ({ id, text })));
        }, 0),
        verificationFailures: Object.values(result.tasks).filter(state => state.verification?.outcome !== "passed").length,
        externalProviderCalls: 0,
        billedCostUsd: null as number | null,
      };
    };

    const modes = ["no_board", "targeted", "broadcast"] as const;
    const runs = Object.fromEntries(modes.map(mode => [mode, [] as Awaited<ReturnType<typeof runArm>>[]])) as Record<typeof modes[number], Awaited<ReturnType<typeof runArm>>[]>;
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const mode of modes) runs[mode].push(await runArm(mode));
    }
    const summarize = (samples: Awaited<ReturnType<typeof runArm>>[]) => {
      const keys = ["elapsedMs", "completedTasks", "verifiedTasks", "workerModelCalls", "workerInputTokensEstimated", "workerOutputTokensEstimated", "totalTokensEstimated", "fixtureLookupCalls", "duplicateLookupCalls", "boardMessages", "visibleMessageBytesAcrossWorkers", "verificationFailures"] as const;
      return Object.fromEntries(keys.map(key => {
        const values = samples.map(item => item[key] as number);
        const sorted = [...values].sort((a, b) => a - b);
        return [key, { samples: values, mean: values.reduce((sum, value) => sum + value, 0) / values.length, p50: sorted[Math.floor((sorted.length - 1) * 0.5)], p95: sorted[Math.ceil((sorted.length - 1) * 0.95)] }];
      }));
    };
    const report = {
      schemaVersion: 1,
      kind: "matched_blackboard_task_outcome_ablation",
      evidenceClass: "local-goal-dag-with-deterministic-worker-and-verifier-fixtures",
      policyArms: ["no_board", "targeted", "broadcast"],
      groups,
      consumersPerGroup,
      tasksPerRun: tasks.length,
      repeats,
      concurrency: 4,
      taskObjectivesMatchedAcrossArms: true,
      targetedRecipientsPerSource: 2,
      broadcastRecipientsPerSource: tasks.length - groups,
      results: Object.fromEntries(modes.map(mode => [mode, { summary: summarize(runs[mode]), samples: runs[mode] }])),
      interpretation: {
        duplicateLookupUnits: "fixture lookups beyond one source lookup per group; deterministic duplicate-work proxy",
        tokenUnits: "estimated as ceil(UTF-8 JSON bytes / 4), not provider tokenizer counts",
        modelCalls: "synthetic worker invocations, one per task; no external model provider was called",
        cost: "null because there are no provider billing receipts; synthetic deterministic execution is not a cash-cost benchmark",
        verifiedCompletion: "each task result checked by GoalDagHost.verify against a fixed expected fixture value",
      },
      limitations: [
        "This exercises the actual Goal DAG scheduling, message creation, recipient visibility, and host verification with deterministic fixture workers; it does not use live Gemini, GroqCloud, or OpenRouter worker models.",
        "The broadcast arm is an explicit synthetic all-peers recipient policy; production host routing does not automatically broadcast every task result.",
        "Token counts are byte-based estimates and do not model a tokenizer, hidden system prompts, provider caching, or model reasoning.",
        "Three local repetitions provide a small runtime comparison, not a production latency distribution or evidence of cost savings.",
      ],
    };
    const path = process.env.NAELAO_BLACKBOARD_TASK_OUTCOME_REPORT;
    if (path) await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`blackboard_task_outcome_ablation=${JSON.stringify(report)}`);

    for (const mode of modes) {
      for (const sample of runs[mode]) {
        expect(sample.completedTasks).toBe(tasks.length);
        expect(sample.verifiedTasks).toBe(tasks.length);
        expect(sample.verificationFailures).toBe(0);
        expect(sample.workerModelCalls).toBe(tasks.length);
        expect(sample.externalProviderCalls).toBe(0);
      }
    }
    expect(runs.no_board[0]?.duplicateLookupCalls).toBe(groups * consumersPerGroup);
    expect(runs.targeted[0]?.duplicateLookupCalls).toBe(groups);
    expect(runs.broadcast[0]?.duplicateLookupCalls).toBe(0);
    expect(runs.broadcast[0]?.visibleMessageBytesAcrossWorkers).toBeGreaterThan(runs.targeted[0]?.visibleMessageBytesAcrossWorkers ?? 0);
    expect(runs.no_board.map(item => item.verifiedTasks)).toEqual(runs.targeted.map(item => item.verifiedTasks));
    expect(runs.targeted.map(item => item.verifiedTasks)).toEqual(runs.broadcast.map(item => item.verifiedTasks));
  });
});
