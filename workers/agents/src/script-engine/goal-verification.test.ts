import { describe, expect, it, vi } from "vitest";
import { OPENROUTER_DECISIONS_ENDPOINT, SystemOneDecisionClient } from "@naelao/agent-sdk";
import { executeGoalDag, type GoalDagHost, type GoalDagJournal } from "./goal-dag.js";
import { assessGoalEvidence } from "./goal-verification.js";
import { collectGoalEvidence, type GoalEvidenceCheck } from "./goal-evidence.js";
import type { GoalTask } from "./prebuilt/goal-planner.js";

function decisionClient(value: "passed" | "uncertain") {
  let calls = 0;
  let reservations = 0;
  let settlements = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(OPENROUTER_DECISIONS_ENDPOINT);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-test-key");
    calls++;
    const request = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, { criteria: Record<string, unknown> }> };
    const allowed = Object.keys(request.questions.decision!.criteria);
    const choice = allowed.includes(value) ? value : "uncertain";
    return Response.json({
      id: `gen-goal-${calls}`,
      model: request.model,
      answers: { decision: { type: "choice", choice, probabilities: Object.fromEntries(allowed.map(key => [key, key === choice ? 1 : 0])), confidence: 1 } },
      usage: { input_tokens: 48, output_tokens: 4, cost: 0.000000052 },
    });
  }) as typeof globalThis.fetch;
  const client = new SystemOneDecisionClient({
    apiKey: "local-test-key",
    fetch,
    maxRetries: 0,
    billing: {
      reserve: async ({ model, requestBytes, idempotencyKey }) => {
        expect(model).toBe("cloudflare/clef-flash");
        expect(requestBytes).toBeGreaterThan(0);
        expect(idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
        reservations++;
        return `reservation-${reservations}`;
      },
      settle: async (_reservation, outcome) => {
        expect(outcome.status).toBe("confirmed");
        if (outcome.status === "confirmed") {
          expect(outcome.generationId).toMatch(/^gen-goal-/);
          expect(outcome.costUsd).toBe(0.000000052);
        }
        settlements++;
      },
    },
  });
  return { client, fetch, get counts() { return { calls, reservations, settlements }; } };
}

function verifiedTask(id: string, file: string, dependencies: string[] = []): GoalTask {
  const criterion = `${id} output exists`;
  return {
    id,
    title: `Create ${id}`,
    subtask_spec: `Create ${file}`,
    assigned_role: "DEV_OPERATOR",
    dependencies,
    acceptance_criteria: [criterion],
    evidence_checks: [{ criterion, operation: `workspace.exists:${file}` }],
    file_paths: [file],
    budget_tokens: 1_000,
  };
}

function hostFixture(decision: ReturnType<typeof decisionClient>, evidenceOutcome: "passed" | "uncertain" = "passed") {
  let journal: GoalDagJournal | undefined;
  const launched: string[] = [];
  const host: GoalDagHost = {
    concurrency: 1,
    verificationRequired: true,
    workerId: id => `worker:${id}`,
    load: async () => journal && structuredClone(journal),
    save: async next => { journal = structuredClone(next); },
    publish: async () => undefined,
    recover: async () => undefined,
    launch: async (task, id) => {
      if (task.id === "downstream") expect(journal?.tasks["upstream"]?.verification?.outcome).toBe("passed");
      launched.push(task.id);
      return { id, ok: true, output: "worker-reported-success" };
    },
    collectEvidence: async (task) => collectGoalEvidence(
      task.acceptance_criteria ?? [],
      task.evidence_checks as GoalEvidenceCheck[] ?? [],
      async operation => ({ outcome: evidenceOutcome, reference: `host-manifest:${operation}` }),
    ),
    assessEvidence: async (task, evidence, deterministic) => assessGoalEvidence(decision.client, task, evidence, deterministic),
  };
  return { host, launched, get journal() { return journal; } };
}

describe("goal evidence, Decisions, billing, and DAG enforcement integration", () => {
  it("settles the real Decisions client and dispatches a dependent only after host evidence and model assessment pass", async () => {
    const decision = decisionClient("passed");
    const tasks = [verifiedTask("upstream", "reports/source.txt"), verifiedTask("downstream", "reports/summary.txt", ["upstream"])];
    const f = hostFixture(decision);

    const result = await executeGoalDag(tasks, f.host);

    expect(f.launched).toEqual(["upstream", "downstream"]);
    expect(result.tasks["upstream"]).toMatchObject({ status: "completed", verification: { outcome: "passed" } });
    expect(result.tasks["downstream"]).toMatchObject({ status: "completed", verification: { outcome: "passed" } });
    expect(decision.counts).toEqual({ calls: 2, reservations: 2, settlements: 2 });
    expect(decision.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not call Decisions or launch dependent work when independent host evidence is uncertain", async () => {
    const decision = decisionClient("passed");
    const tasks = [verifiedTask("upstream", "reports/source.txt"), verifiedTask("downstream", "reports/summary.txt", ["upstream"])];
    const f = hostFixture(decision, "uncertain");

    const result = await executeGoalDag(tasks, f.host);

    expect(f.launched).toEqual(["upstream"]);
    expect(result.tasks["upstream"]).toMatchObject({ status: "needs_review", verification: { outcome: "uncertain" } });
    expect(result.tasks["downstream"]?.status).toBe("blocked");
    expect(decision.counts).toEqual({ calls: 0, reservations: 0, settlements: 0 });
  });

  it("routes a Decisions uncertainty to review and blocks descendants after settling the confirmed provider usage", async () => {
    const decision = decisionClient("uncertain");
    const tasks = [verifiedTask("upstream", "reports/source.txt"), verifiedTask("downstream", "reports/summary.txt", ["upstream"])];
    const f = hostFixture(decision);

    const result = await executeGoalDag(tasks, f.host);

    expect(f.launched).toEqual(["upstream"]);
    expect(result.tasks["upstream"]).toMatchObject({ status: "needs_review", verification: { outcome: "uncertain" } });
    expect(result.tasks["downstream"]?.status).toBe("blocked");
    expect(decision.counts).toEqual({ calls: 1, reservations: 1, settlements: 1 });
  });
});
