import { describe, it, expect } from "vitest";
import { AgentTaskWorkflow } from "../../workers/agents/src/workflows/AgentTaskWorkflow.js";
import type { AgentTaskParams } from "../../workers/agents/src/workflows/AgentTaskWorkflow.js";

// Live-reported bug (2026-08-07): "Timed out waiting for a response" on EVERY message,
// reproduced directly against production. Root cause: AgentTaskWorkflow's "run-agent" step threw
// on any non-ok response from the agents worker's internal run endpoint — and since that step has
// zero retries by design (an agent run is not idempotent), the exception propagated straight out
// of `run()` uncaught. Step 3 ("update-result", the only place that ever writes a terminal
// status) never executed, so the task sat in TaskDO status "processing" forever: the client polls
// for MAX_POLL_DURATION_MS, times out, and a page refresh just reattaches to the same
// never-resolving run and hangs identically. These tests drive the REAL AgentTaskWorkflow class
// (not a reimplementation of its logic) through a fake WorkflowStep that mirrors CF's own
// retry/rethrow contract, proving a task always reaches a terminal TaskDO status no matter which
// step fails.

function makeFakeStep() {
  const attempts: Record<string, number> = {};
  return {
    attempts,
    async do(name: string, config: { retries?: { limit?: number } } | undefined, cb: () => Promise<unknown>) {
      const limit = config?.retries?.limit ?? 0;
      let lastErr: unknown;
      for (let i = 0; i <= limit; i++) {
        attempts[name] = (attempts[name] ?? 0) + 1;
        try {
          return await cb();
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    },
  };
}

function makeFakeTaskDO() {
  const tasks = new Map<string, { status: string; result: string | null; error: string | null }>();
  tasks.set("task-1", { status: "queued", result: null, error: null });
  const stub = {
    // Real DO stubs (and the actual production call sites here) use the two-arg
    // fetch(url, init) form, not a pre-built Request — matching that shape here is what
    // surfaced the original test-authoring mistake (a bare string has no .url property).
    async fetch(input: string, init?: RequestInit) {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const m = url.pathname.match(/\/tasks\/([^/]+)(\/status)?$/);
      const taskId = m?.[1] ?? "task-1";
      if (req.method === "PUT" && url.pathname.endsWith("/status")) {
        const body = (await req.json()) as { status: string; result?: string | null; error?: string | null };
        tasks.set(taskId, {
          status: body.status,
          result: body.result ?? null,
          error: body.error ?? null,
        });
        return Response.json({ ok: true });
      }
      const t = tasks.get(taskId);
      if (!t) return new Response("not found", { status: 404 });
      return Response.json(t);
    },
  };
  return { tasks, stub };
}

function makeEnv(opts: { taskDoStub: ReturnType<typeof makeFakeTaskDO>["stub"]; agentsWorkerFetch: (req: Request) => Promise<Response> }) {
  return {
    TASK_DO: { idFromName: (name: string) => name, get: () => opts.taskDoStub },
    AGENTS_WORKER: { fetch: opts.agentsWorkerFetch },
    PLATFORM_SECRET: "test-secret",
    // reportWorkflowStepInfraUsage degrades to a no-op when BILLING_WORKER is absent.
  } as unknown as ConstructorParameters<typeof AgentTaskWorkflow>[1];
}

const baseParams: AgentTaskParams = {
  taskId: "task-1",
  spaceId: "space-1",
  sessionId: "sess-1",
  tenantId: "tenant-1",
  goal: "hello",
  agentId: "naelao-agent",
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  taskDoName: "task-do-1",
};

describe("AgentTaskWorkflow — a failure always reaches a terminal TaskDO status", () => {
  it("a non-ok response from the agents worker (e.g. an LLM/quota error) marks the task failed, not stuck processing", async () => {
    const { tasks, stub } = makeFakeTaskDO();
    const env = makeEnv({
      taskDoStub: stub,
      agentsWorkerFetch: async () =>
        new Response(
          JSON.stringify({ error: "4006: you have used up your daily free allocation of 10,000 neurons" }),
          { status: 500 }
        ),
    });
    const wf = new AgentTaskWorkflow({} as never, env);
    const step = makeFakeStep();
    await wf.run({ payload: baseParams, instanceId: "wf-1" } as never, step as never);

    const final = tasks.get("task-1")!;
    expect(final.status).toBe("failed");
    expect(final.error).toContain("4006");
    // mark-processing must have run before the failure — a real symptom of the bug would be the
    // task never even reaching "processing", which reads as "stuck queued" to a poller.
    expect(step.attempts["mark-processing"]).toBeGreaterThan(0);
    expect(step.attempts["update-result"]).toBeGreaterThan(0);
  });

  it("a network-level throw (fetch itself rejects) also reaches a terminal failed status", async () => {
    const { tasks, stub } = makeFakeTaskDO();
    const env = makeEnv({
      taskDoStub: stub,
      agentsWorkerFetch: async () => {
        throw new Error("network unreachable");
      },
    });
    const wf = new AgentTaskWorkflow({} as never, env);
    const step = makeFakeStep();
    await wf.run({ payload: baseParams, instanceId: "wf-2" } as never, step as never);

    const final = tasks.get("task-1")!;
    expect(final.status).toBe("failed");
    expect(final.error).toContain("network unreachable");
  });

  it("a real success still completes normally (no regression from the try/catch)", async () => {
    const { tasks, stub } = makeFakeTaskDO();
    const env = makeEnv({
      taskDoStub: stub,
      agentsWorkerFetch: async () =>
        Response.json({ finalAnswer: "Hello! How can I help?", status: "completed" }),
    });
    const wf = new AgentTaskWorkflow({} as never, env);
    const step = makeFakeStep();
    await wf.run({ payload: baseParams, instanceId: "wf-3" } as never, step as never);

    const final = tasks.get("task-1")!;
    expect(final.status).toBe("complete");
    expect(final.error).toBeNull();
    expect(JSON.parse(final.result!).final_answer).toBe("Hello! How can I help?");
  });

  it("a run that opens a real approval and only THEN fails keeps the approval, not just the error", async () => {
    const { tasks, stub } = makeFakeTaskDO();
    const env = makeEnv({
      taskDoStub: stub,
      agentsWorkerFetch: async () =>
        new Response(
          JSON.stringify({
            error: "unrelated second-turn failure",
            deferred_approvals: [{ approval_id: "appr-1", action_name: "commerce.payout" }],
          }),
          { status: 500 }
        ),
    });
    const wf = new AgentTaskWorkflow({} as never, env);
    const step = makeFakeStep();
    await wf.run({ payload: baseParams, instanceId: "wf-4" } as never, step as never);

    const final = tasks.get("task-1")!;
    expect(final.status).toBe("failed");
    expect(final.error).toBe("unrelated second-turn failure");
    expect(JSON.parse(final.result!).deferred_approvals[0].approval_id).toBe("appr-1");
  });

  it("even if TaskDO itself is unreachable throughout, run() resolves rather than throwing uncaught", async () => {
    const stub = {
      async fetch() {
        throw new Error("DO unreachable");
      },
    };
    const env = makeEnv({
      taskDoStub: stub as never,
      agentsWorkerFetch: async () => new Response("boom", { status: 500 }),
    });
    const wf = new AgentTaskWorkflow({} as never, env);
    const step = makeFakeStep();
    await expect(wf.run({ payload: baseParams, instanceId: "wf-5" } as never, step as never)).resolves.toBeUndefined();
  });
});
