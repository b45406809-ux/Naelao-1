import { describe, it, expect } from "vitest";
import { AgentTaskWorkflow } from "../../workers/agents/src/workflows/AgentTaskWorkflow.js";
import type { AgentTaskParams } from "../../workers/agents/src/workflows/AgentTaskWorkflow.js";
import { WorkflowRunDO } from "../../workers/agents/src/do/WorkflowRunDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

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
    async do(name: string, configOrCallback: { retries?: { limit?: number } } | (() => Promise<unknown>) | undefined, callback?: () => Promise<unknown>) {
      const config = typeof configOrCallback === "function" ? undefined : configOrCallback;
      const cb = typeof configOrCallback === "function" ? configOrCallback : callback;
      if (!cb) throw new Error("workflow step callback missing");
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
  const objectStore = new Map<string, string>();
  const scriptsR2 = {
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
      objectStore.set(key, typeof value === "string" ? value : new TextDecoder().decode(value instanceof ArrayBuffer ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
    },
    async get(key: string) {
      const value = objectStore.get(key);
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return { size: bytes.byteLength, async text() { return value; }, async arrayBuffer() { return bytes.slice().buffer; } };
    },
    async delete(key: string) { objectStore.delete(key); },
    async list({ prefix }: { prefix?: string }) {
      const objects = [...objectStore].filter(([key]) => key.startsWith(prefix ?? "")).map(([key, value]) => ({ key, size: new TextEncoder().encode(value).byteLength }));
      return { objects, truncated: false };
    },
  } as unknown as R2Bucket;
  for (const filename of ["agents.md", "system-prompt.md", "scripts.json", "skills.json"]) {
    objectStore.set(`spaces/space-1/agents/naelao-agent/${filename}`, filename.endsWith(".json") ? "[]" : "");
  }
  const spacesWorker = {
    async fetch(input: Request | string, init?: RequestInit) {
      const request = typeof input === "string" ? new Request(input, init) : input;
      const path = new URL(request.url).pathname;
      if (path === "/spaces/space-1/members") {
        const userId = request.headers.get("x-naelao-user-id") ?? "user-1";
        return Response.json({ data: [{ user_id: userId, role: "owner" }] });
      }
      if (path === "/spaces/space-1/projects/proj-1/members") {
        const userId = request.headers.get("x-naelao-user-id") ?? "user-1";
        return Response.json({ data: [{ user_id: userId, role: "owner" }] });
      }
      return new Response("not found", { status: 404 });
    },
  };
  const workflowInstances = new Map<string, WorkflowRunDO>();
  const workflowRunNamespace = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let object = workflowInstances.get(id);
      if (!object) {
        const storage = createDOStorage() as ReturnType<typeof createDOStorage> & Record<string, unknown>;
        const values = new Map<string, unknown>();
        Object.assign(storage, {
          async get(key: string) { return values.get(key); },
          async put(key: string, value: unknown) { values.set(key, value); },
          async delete(keys: string | string[]) {
            for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
          },
          async list(options: { prefix?: string; limit?: number } = {}) {
            const entries = [...values.entries()].filter(([key]) => key.startsWith(options.prefix ?? ""));
            return new Map(entries.slice(0, options.limit ?? entries.length));
          },
          async transaction<T>(closure: (target: typeof storage) => Promise<T>) { return closure(storage); },
        });
        object = new WorkflowRunDO({ storage } as never, workflowEnv as never);
        workflowInstances.set(id, object);
      }
      return object;
    },
  };
  const workflowEnv = {
    PLATFORM_SECRET: "test-secret",
    SCRIPTS_R2: scriptsR2,
    SPACES_WORKER: spacesWorker,
    WORKFLOW_RUN_DO: workflowRunNamespace,
  };
  return {
    TASK_DO: { idFromName: (name: string) => name, get: () => opts.taskDoStub },
    AGENTS_WORKER: { fetch: opts.agentsWorkerFetch },
    PLATFORM_SECRET: "test-secret",
    WORKFLOW_BUILD_ID: "a".repeat(64),
    SCRIPTS_R2: scriptsR2,
    SPACES_WORKER: spacesWorker,
    WORKFLOW_RUN_DO: workflowRunNamespace,
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
  taskDoName: "tasks:space-1",
  userId: "user-1",
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
    await wf.run({ payload: baseParams, instanceId: "task-1" } as never, step as never);

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
    await wf.run({ payload: baseParams, instanceId: "task-1" } as never, step as never);

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
    await wf.run({ payload: baseParams, instanceId: "task-1" } as never, step as never);

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
    await wf.run({ payload: baseParams, instanceId: "task-1" } as never, step as never);

    const final = tasks.get("task-1")!;
    expect(final.status).toBe("failed");
    expect(final.error).toBe("unrelated second-turn failure");
    expect(JSON.parse(final.result!).deferred_approvals[0].approval_id).toBe("appr-1");
  });

  it("a billing-gate 402 (insufficient_credits) carries error_code through into TaskDO's result, not just the raw error text", async () => {
    // Live-reported bug (2026-08-11): a caller hitting a billing gate got only the bare error
    // sentence — error_code was parsed here and then silently dropped, so a polling client had no
    // reliable way to render an upgrade dialog instead of a plain error banner. Before the fix,
    // `result` was `null` here (hasError && no deferred_approvals), so error_code had nowhere to
    // land even if it HAD been captured.
    const { tasks, stub } = makeFakeTaskDO();
    const env = makeEnv({
      taskDoStub: stub,
      agentsWorkerFetch: async () =>
        new Response(
          JSON.stringify({ error: "insufficient credits — top up or subscribe to keep chatting", error_code: "insufficient_credits" }),
          { status: 402 }
        ),
    });
    const wf = new AgentTaskWorkflow({} as never, env);
    const step = makeFakeStep();
    await wf.run({ payload: baseParams, instanceId: "task-1" } as never, step as never);

    const final = tasks.get("task-1")!;
    expect(final.status).toBe("failed");
    expect(final.error).toContain("insufficient credits");
    expect(final.result).not.toBeNull();
    expect(JSON.parse(final.result!).error_code).toBe("insufficient_credits");
  });

  it("a plain non-billing failure still carries no error_code at all (result stays null)", async () => {
    const { tasks, stub } = makeFakeTaskDO();
    const env = makeEnv({
      taskDoStub: stub,
      agentsWorkerFetch: async () => new Response(JSON.stringify({ error: "some other failure" }), { status: 500 }),
    });
    const wf = new AgentTaskWorkflow({} as never, env);
    const step = makeFakeStep();
    await wf.run({ payload: baseParams, instanceId: "task-1" } as never, step as never);

    const final = tasks.get("task-1")!;
    expect(final.status).toBe("failed");
    expect(final.result).toBeNull();
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
    await expect(wf.run({ payload: baseParams, instanceId: "task-1" } as never, step as never)).resolves.toBeUndefined();
  });
});

describe("AgentTaskWorkflow forwards the gate-relevant identity fields", () => {
  /**
   * This is the DEFAULT dispatch path for every real chat message, and it silently dropped
   * `businessRole` — declared nowhere on AgentTaskParams, forwarded nowhere in the run-agent step,
   * even though /agent/run was already resolving it and passing it in. Without it the F-36 clamp
   * downgrades `yolo` for every product_end_user, including a business's OWNER: an owner who set
   * their own business to Autonomous still had every action gated with nobody but themself to
   * approve it. Reproduced live before the fix.
   *
   * The same "fixed on the sync path, missed on the async one" mistake has now happened twice, so
   * this asserts the whole set rather than the one field that broke.
   */
  it("carries businessRole, callerRole, userId, projectId and businessContext through to the executor", async () => {
    const { stub } = makeFakeTaskDO();
    let forwarded: Record<string, unknown> = {};
    const env = makeEnv({
      taskDoStub: stub,
      agentsWorkerFetch: (async (_url: string, init: RequestInit) =>
        ((forwarded = JSON.parse(String(init.body))),
        Response.json({ finalAnswer: "done", status: "completed" }))) as never,
    });

    const wf = new AgentTaskWorkflow({} as never, env);
    await wf.run(
      {
        payload: {
          ...baseParams,
          userId: "user-1",
          callerRole: "product_end_user",
          businessRole: "owner",
          projectId: "proj-1",
          businessContext: { name: "Pixel Forge Studio", setup_status: "complete" },
        },
        instanceId: "task-1",
      } as never,
      makeFakeStep() as never
    );

    // The one that broke: without it, an owner's own Autonomous setting is silently downgraded.
    expect(forwarded["businessRole"]).toBe("owner");
    expect(forwarded["callerRole"]).toBe("product_end_user");
    expect(forwarded["userId"]).toBe("user-1");
    expect(forwarded["projectId"]).toBe("proj-1");
    expect((forwarded["businessContext"] as { name?: string })?.name).toBe("Pixel Forge Studio");
  });

  it("omits nothing merely because the caller is a builder with no business role", async () => {
    const { stub } = makeFakeTaskDO();
    let forwarded: Record<string, unknown> = {};
    const env = makeEnv({
      taskDoStub: stub,
      agentsWorkerFetch: (async (_url: string, init: RequestInit) =>
        ((forwarded = JSON.parse(String(init.body))),
        Response.json({ finalAnswer: "done", status: "completed" }))) as never,
    });

    const wf = new AgentTaskWorkflow({} as never, env);
    await wf.run(
      { payload: { ...baseParams, userId: "builder-1", callerRole: "owner" }, instanceId: "task-1" } as never,
      makeFakeStep() as never
    );

    // A builder has no business_memberships row; absent is correct and must not become "member".
    expect(forwarded["businessRole"]).toBeUndefined();
    expect(forwarded["callerRole"]).toBe("owner");
  });
});
