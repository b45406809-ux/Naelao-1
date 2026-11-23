import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { executeGoalDag, type GoalDagHost, type GoalDagJournal } from "./goal-dag.js";
import { collectGoalEvidence } from "./goal-evidence.js";
import type { GoalTask } from "./prebuilt/goal-planner.js";

type Workload = {
  id: string;
  domain: "code" | "non_code";
  size: "small" | "medium" | "large";
  items: Array<{ id: string; path: string; durationMs: number; inputTokens: number; outputTokens: number; resource?: string }>;
};
type Strategy = "one_worker" | "sequential" | "adaptive_parallel";
const STRATEGIES: Strategy[] = ["one_worker", "sequential", "adaptive_parallel"];
const REPEATS = 2;

function criterionFor(item: Workload["items"][number]): string {
  return `The requested artifact ${item.path} is available to the host`;
}

function makeWorkloads(): Workload[] {
  return (["code", "non_code"] as const).flatMap(domain => (["small", "medium", "large"] as const).map(size => {
    const count = size === "small" ? 2 : size === "medium" ? 4 : 6;
    const durationMs = size === "small" ? 6 : size === "medium" ? 8 : 10;
    return {
      id: `${size}-${domain}`,
      domain,
      size,
      items: Array.from({ length: count }, (_, index) => ({
        id: `unit-${index + 1}`,
        path: `${domain}/${size}/unit-${index + 1}.txt`,
        durationMs,
        inputTokens: 90 + index * 10,
        outputTokens: 24 + index * 4,
        // Repeated file/resource classes stand in for shared edit contention in code tasks.
        ...(domain === "code" && size !== "small" ? { resource: `file-group-${Math.floor(index / 2)}` } : {}),
      })),
    };
  }));
}

function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.ceil(quantile * sorted.length) - 1]!.toFixed(2));
}

function taskFor(item: Workload["items"][number]): GoalTask {
  return {
    id: item.id,
    title: `Complete ${item.id}`,
    subtask_spec: `Produce the supplied deterministic ${item.path} fixture.`,
    assigned_role: "schema-validator",
    context_affinity: "isolated",
    file_paths: [item.path],
    acceptance_criteria: [criterionFor(item)],
    evidence_checks: [{ criterion: criterionFor(item), operation: `workspace.exists:${item.path}` }],
    ...(item.resource ? { resource_keys: [item.resource] } : {}),
    budget_tokens: item.inputTokens + item.outputTokens + 64,
  };
}

async function runArm(workload: Workload, strategy: Strategy, repeat: number) {
  let journal: GoalDagJournal | undefined;
  const artifacts = new Set<string>();
  const dispatched = new Set<string>();
  const workerAttempts = new Map<string, number>();
  const completedWorkers = new Map<string, { id: string; ok: boolean; output: string }>();
  const activeResources = new Set<string>();
  let active = 0;
  let peakActive = 0;
  let resourceOverlaps = 0;
  let duplicateDispatches = 0;
  let redispatches = 0;
  let dispatchAttempts = 0;
  let recoveryRequests = 0;
  let mockTokens = 0;
  const oneWorker = strategy === "one_worker";
  const tasks: GoalTask[] = oneWorker
    ? [{
      id: "whole-objective",
      title: `Complete ${workload.id}`,
      subtask_spec: `Complete all ${workload.items.length} predeclared work units for ${workload.id}.`,
      assigned_role: "schema-validator",
      context_affinity: "isolated",
      file_paths: workload.items.map(item => item.path),
      acceptance_criteria: workload.items.map(criterionFor),
      evidence_checks: workload.items.map(item => ({ criterion: criterionFor(item), operation: `workspace.exists:${item.path}` })),
      ...(workload.items.some(item => item.resource)
        ? { resource_keys: [...new Set(workload.items.flatMap(item => item.resource ? [item.resource] : []))] }
        : {}),
      budget_tokens: workload.items.reduce((sum, item) => sum + item.inputTokens + item.outputTokens + 64, 0),
    }]
    : workload.items.map(taskFor);
  const host: GoalDagHost = {
    concurrency: strategy === "adaptive_parallel" ? 4 : 1,
    adaptiveConcurrency: strategy === "adaptive_parallel",
    verificationRequired: true,
    workerId: taskId => `fixture:${workload.id}:${strategy}:${repeat}:${taskId}`,
    load: async () => journal && structuredClone(journal),
    save: async state => { journal = structuredClone(state); },
    publish: async () => undefined,
    recover: async workerId => {
      recoveryRequests++;
      return completedWorkers.get(workerId);
    },
    launch: async () => { throw new Error("comparative_fixture_requires_dispatch"); },
    dispatch: async (task, workerId, _handoffs, dispatchId) => {
      dispatchAttempts++;
      const attempts = (workerAttempts.get(workerId) ?? 0) + 1;
      workerAttempts.set(workerId, attempts);
      if (attempts > 1) redispatches++;
      if (dispatched.has(dispatchId)) duplicateDispatches++;
      dispatched.add(dispatchId);
      const work = oneWorker ? workload.items : workload.items.filter(item => item.id === task.id);
      for (const key of task.resource_keys ?? []) {
        if (activeResources.has(key)) resourceOverlaps++;
        activeResources.add(key);
      }
      active++;
      peakActive = Math.max(peakActive, active);
      await new Promise(resolve => setTimeout(resolve, work.reduce((sum, item) => sum + item.durationMs, 0)));
      active--;
      for (const key of task.resource_keys ?? []) activeResources.delete(key);
      for (const item of work) {
        artifacts.add(item.path);
        mockTokens += item.inputTokens + item.outputTokens;
      }
      const result = { id: workerId, ok: true, output: `fixture:${workload.id}:${task.id}` };
      completedWorkers.set(workerId, result);
      // Simulate one lost response after the worker has completed. The host must recover the
      // existing result instead of redispatching the worker or counting its effects twice.
      if (task.id === (oneWorker ? "whole-objective" : "unit-1")) throw new Error("fixture_lost_acknowledgement");
      return { acknowledged: true, result };
    },
    collectEvidence: async task => collectGoalEvidence(task.acceptance_criteria ?? [], task.evidence_checks ?? [], async operation => {
      const path = operation.slice(operation.indexOf(":") + 1);
      return artifacts.has(path)
        ? { outcome: "passed", reference: `fixture-workspace:${path}` }
        : { outcome: "uncertain", reference: `fixture-workspace:${path}:missing` };
    }),
  };
  const startedAt = performance.now();
  const result = await executeGoalDag(tasks, host);
  const latencyMs = performance.now() - startedAt;
  const taskStates = Object.values(result.tasks);
  const verifiedArtifacts = tasks.reduce((sum, task) => {
    const state = result.tasks[task.id];
    return sum + (state?.status === "completed" && state.verification?.outcome === "passed" ? task.evidence_checks?.length ?? 0 : 0);
  }, 0);
  return {
    workload: workload.id,
    domain: workload.domain,
    size: workload.size,
    strategy,
    repeat,
    latencyMs,
    workers: dispatched.size,
    mockTokens,
    dispatchAttempts,
    recoveryRequests,
    recoveredLostAcknowledgements: recoveryRequests,
    redispatches,
    peakActive,
    resourceOverlaps,
    duplicateDispatches,
    verifiedArtifacts,
    expectedArtifacts: workload.items.length,
    verifiedTasks: taskStates.filter(state => state.status === "completed" && state.verification?.outcome === "passed").length,
    expectedTasks: tasks.length,
    unexpectedStatuses: taskStates.filter(state => state.status !== "completed").map(state => state.status),
  };
}

describe("controlled goal routing comparison fixture", () => {
  it("compares fixed one-worker, sequential and adaptive arms without provider or dollar-cost claims", async () => {
    const workloads = makeWorkloads();
    const runs: Awaited<ReturnType<typeof runArm>>[] = [];
    for (const workload of workloads) for (let repeat = 1; repeat <= REPEATS; repeat++) {
      // Rotate the deterministic arm order by workload/repeat to reduce systematic warm-up bias.
      const offset = (workloads.indexOf(workload) + repeat - 1) % STRATEGIES.length;
      const order = [...STRATEGIES.slice(offset), ...STRATEGIES.slice(0, offset)];
      for (const strategy of order) runs.push(await runArm(workload, strategy, repeat));
    }
    const expectedTokens = (workload: Workload) => workload.items.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0);
    const byStrategy = Object.fromEntries(STRATEGIES.map(strategy => {
      const selected = runs.filter(run => run.strategy === strategy);
      return [strategy, {
        runs: selected.length,
        verifiedTasks: selected.reduce((sum, run) => sum + run.verifiedTasks, 0),
        expectedTasks: selected.reduce((sum, run) => sum + run.expectedTasks, 0),
        verifiedArtifacts: selected.reduce((sum, run) => sum + run.verifiedArtifacts, 0),
        expectedArtifacts: selected.reduce((sum, run) => sum + run.expectedArtifacts, 0),
        mockTokens: selected.reduce((sum, run) => sum + run.mockTokens, 0),
        workerDispatches: selected.reduce((sum, run) => sum + run.workers, 0),
        dispatchAttempts: selected.reduce((sum, run) => sum + run.dispatchAttempts, 0),
        recoveryRequests: selected.reduce((sum, run) => sum + run.recoveryRequests, 0),
        recoveredLostAcknowledgements: selected.reduce((sum, run) => sum + run.recoveredLostAcknowledgements, 0),
        redispatches: selected.reduce((sum, run) => sum + run.redispatches, 0),
        latencyMs: { p50: percentile(selected.map(run => run.latencyMs), 0.5), p95: percentile(selected.map(run => run.latencyMs), 0.95) },
        peakConcurrencyMax: Math.max(...selected.map(run => run.peakActive)),
        resourceOverlaps: selected.reduce((sum, run) => sum + run.resourceOverlaps, 0),
        duplicateDispatches: selected.reduce((sum, run) => sum + run.duplicateDispatches, 0),
        incompleteRuns: selected.filter(run => run.unexpectedStatuses.length > 0).length,
      }];
    }));
    const report = {
      schemaVersion: 1,
      kind: "goal_routing_comparative_fixture",
      dataset: "6 fixed synthetic workloads: small/medium/large code and non-code; 2 repeats; 3 arms",
      controls: {
        taskInputs: "same predeclared work units, acceptance criteria and host evidence checks in each paired workload",
        models: "none; deterministic in-memory worker adapter",
        workerTimes: "fixed per work unit across arms",
        tokenUsage: "fixed synthetic input/output token counts; equal total per paired workload",
        failureInjection: "one lost acknowledgement after completed work per run; recovery returns the existing result",
        order: "deterministically rotated across arms",
        providerCalls: 0,
        externalWrites: 0,
        providerSpendUsd: null,
      },
      counts: {
        workloads: workloads.length,
        repeatsPerArm: REPEATS,
        arms: STRATEGIES.length,
        totalRuns: runs.length,
        allTasksHostVerified: runs.every(run => run.verifiedTasks === run.expectedTasks && run.unexpectedStatuses.length === 0),
        allArtifactsHostVerified: runs.every(run => run.verifiedArtifacts === run.expectedArtifacts),
        tokenTotalsMatchWithinPairs: workloads.every(workload => {
          const paired = runs.filter(run => run.workload === workload.id);
          return paired.every(run => run.mockTokens === expectedTokens(workload));
        }),
      },
      byStrategy,
      limitations: [
        "Host verification of fixture artifacts is a quality proxy only; this is not model or customer-task quality evidence.",
        "Wall time combines fixed timer delays with local test-runner overhead; it is not provider or Cloudflare latency.",
        "Synthetic token counts have no provider price mapping; providerSpendUsd is intentionally unknown.",
        "The fixture covers lost-ack recovery only; it does not measure failed-worker retry policy, external conflicts, cancellation races, durable storage or checked publication.",
      ],
      runs,
    };
    const reportPath = process.env.NAELAO_GOAL_ROUTING_COMPARISON_REPORT;
    if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`goal_routing_comparison=${JSON.stringify(report)}`);

    expect(report.counts.totalRuns).toBe(36);
    expect(report.counts.allTasksHostVerified).toBe(true);
    expect(report.counts.allArtifactsHostVerified).toBe(true);
    expect(report.counts.tokenTotalsMatchWithinPairs).toBe(true);
    for (const strategy of STRATEGIES) {
      expect(byStrategy[strategy]!.incompleteRuns).toBe(0);
      expect(byStrategy[strategy]!.resourceOverlaps).toBe(0);
      expect(byStrategy[strategy]!.duplicateDispatches).toBe(0);
      expect(byStrategy[strategy]!.recoveryRequests).toBe(byStrategy[strategy]!.runs);
      expect(byStrategy[strategy]!.recoveredLostAcknowledgements).toBe(byStrategy[strategy]!.runs);
      expect(byStrategy[strategy]!.redispatches).toBe(0);
    }
  }, 30_000);
});
