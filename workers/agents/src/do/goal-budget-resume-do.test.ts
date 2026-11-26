import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { writeAgentConfig } from "../script-engine/agent-config.js";
import { goalPlanner } from "../script-engine/prebuilt/goal-planner.js";
import { normalizeScriptRunResult } from "../index.js";

// MS-26 (mock/local): hold -> waiting outcome -> raise -> resume dispatches the pending task once ->
// settlement in publish -> double raise does not double-run -> flag off unchanged.
// The run loop is replaced by a fake "model" that calls the REAL goal-planner prebuilt and then
// claims the goal is done, so the waiting outcome must come from the host, not from the model.
const loop = vi.hoisted(() => ({ calls: 0, claimDone: "All done! The goal is complete." }));
vi.mock("../script-engine/loop.js", async importOriginal => {
  const original = await importOriginal<typeof import("../script-engine/loop.js")>();
  return { ...original, runScriptLoop: vi.fn(async (env: { orchestration?: Record<string, unknown> }) => {
    loop.calls++;
    (env as unknown as { workerTokenBudget: number }).workerTokenBudget = 20_000;
    const out = await goalPlanner.operations["engine.plan_and_delegate_goal"]!({ objective: "ship it", tasks: [
      { id: "a", title: "A", subtask_spec: "do a", assigned_role: "DEV_OPERATOR", budget_tokens: 20_000, file_paths: [], dependencies: [] },
      { id: "b", title: "B", subtask_spec: "do b", assigned_role: "DEV_OPERATOR", budget_tokens: 20_000, file_paths: [], dependencies: ["a"] },
    ] }, { env } as never);
    return { level: "L1", notes: [], trace: [{ seq: 0, ts: 0, phase: "run", name: "engine.plan_and_delegate_goal", ok: true, output: JSON.stringify(out).slice(0, 200) }],
      result: { ok: true, output: loop.claimDone, tier: 1, duration_ms: 1, tokens_used: 0 } };
  }) };
});

vi.mock("../communications/core.js", async importOriginal => ({ ...await importOriginal<typeof import("../communications/core.js")>(), scopeAccess: async () => true }));

const { NaelaoAgentDO } = await import("./NaelaoAgentDO.js");

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  return {
    async put(key: string, value: unknown) { store.set(key, typeof value === "string" ? value : new TextDecoder().decode(value as ArrayBuffer)); return {} as R2Object; },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!; const bytes = new TextEncoder().encode(text);
      return { size: bytes.byteLength, uploaded: new Date(), async text() { return text; }, async arrayBuffer() { return bytes.slice().buffer; }, get body() { return text; } } as unknown as R2ObjectBody;
    },
    async head(key: string) { return store.has(key) ? ({} as R2Object) : null; },
    async delete() {},
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      return { objects: [...store.keys()].filter(k => k.startsWith(prefix)).map(k => ({ key: k, size: 1, uploaded: new Date(), etag: "x" })), truncated: false } as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}

async function build(flagOn: boolean) {
  const r2 = makeR2();
  const kv = new Map<string, unknown>();
  const kvApi = { get: async (k: string) => kv.get(k), put: async (k: string, v: unknown) => { kv.set(k, v); }, delete: async (k: string) => kv.delete(k),
    list: async () => new Map(), transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(kvApi) };
  const storage = Object.assign(createDOStorage(), kvApi);
  const waiting: Promise<unknown>[] = [];
  const activity: Array<Record<string, unknown>> = [];
  const messages: Array<Record<string, unknown>> = [];
  const spaces = { fetch: async (input: RequestInfo) => {
    const req = input as Request; const url = new URL(req.url);
    if (/\/agent-activity$/.test(url.pathname) && req.method === "POST") { activity.push(await req.json()); return Response.json({ ok: true }, { status: 201 }); }
    if (/\/messages/.test(url.pathname) && req.method === "POST") { messages.push(await req.json()); return Response.json({ ok: true }, { status: 201 }); }
    if (/^\/spaces\/[^/]+\/projects\/[^/]+$/.test(url.pathname)) return Response.json({ execution_ceiling: 2, daily_spend_cap_credits: 0 });
    if (/\/assistant-access$/.test(url.pathname)) return Response.json({ effective_role: "editor" });
    if (url.pathname === "/internal/worker-preferences") return Response.json({ space_limits: { max_workers: 3, allowed_model_tiers: null, goal_credit_ceiling: 7 }, project_limits: null, user_preferences: null });
    if (/model-policy$/.test(url.pathname)) return Response.json({ policy: null });
    if (url.pathname === "/internal/pricing-catalog") return Response.json({ external_revenue_cut: { enabled: false } });
    if (url.pathname === "/internal/business-subscription-status") return Response.json({ gated: false, active: true, reason: "" });
    return Response.json({ ok: true });
  } };
  const concurrency = { idFromName: (n: string) => n, get: () => ({ fetch: async (r: Request) => {
    const path = new URL(r.url).pathname;
    return Response.json(path.endsWith("/request") ? { acquired: true, token: 1 } : path.endsWith("/renew") ? { renewed: true } : path.endsWith("/release") ? { released: true } : { ok: true });
  } }) };
  const hitl = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ approval_id: "x" }, { status: 201 }) }) };
  const instance = new NaelaoAgentDO({ storage, id: { toString: () => "do-1" }, waitUntil: (p: Promise<unknown>) => { waiting.push(p); } } as never, {
    PLATFORM_SECRET: "ms26", SCRIPTS_R2: r2, SPACES_WORKER: spaces, HITL_APPROVAL_DO: hitl, CONCURRENCY_DO: concurrency, BILLING_WORKER: { fetch: async () => Response.json({ ok: true }) },
    KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") }, NAELAO_AGENT_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) },
    ...(flagOn ? { GOAL_CREDIT_CEILING_ENABLED: "true", WORKER_PREFERENCES_ENABLED: "true" } : {}),
  } as never);
  await writeAgentConfig(r2, "space1", "naelao-agent", { agentsMd: "# Agent", systemPrompt: "bot",
    scripts: { prebuilt: ["goal-planner"], agent_scripts: "auto", startup_observe: "observe_filesystem" }, skills: { skills: [] } });
  const dispatched: string[] = [];
  const spawn = async (config: { tasks: Array<{ sub_agent_id: string }> }) => {
    const id = config.tasks[0]!.sub_agent_id;
    dispatched.push(id);
    storage.sql.exec("INSERT INTO sub_agents(id,parent_run_id,goal,status,budget_tokens,tokens_used) VALUES(?,?,?,?,?,?)", id, "run-1", "g", "done", 20_000, 20_000);
    return { results: [{ id, ok: true, output: "ok" }] };
  };
  // Every orchestration hook set this DO builds (original run and budget resume) dispatches to the fake worker.
  const build_ = (instance as unknown as { buildOrchestrationHooks: (...a: unknown[]) => Record<string, unknown> }).buildOrchestrationHooks.bind(instance);
  (instance as unknown as { buildOrchestrationHooks: unknown }).buildOrchestrationHooks = (...a: unknown[]) => { const h = build_(...a); h.spawnSubAgent = spawn; return h; };
  const journals = () => (storage.sql.exec("SELECT journal_json FROM goal_dag_journals").toArray() as Array<{ journal_json: string }>).map(r => JSON.parse(r.journal_json));
  const credit = () => storage.sql.exec("SELECT credit_ceiling,credits_settled,credits_held,budget_state FROM goal_dag_journals").toArray() as Array<Record<string, unknown>>;
  const run = async () => {
    const response = await instance.fetch(new Request("http://agent-do/script/run", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "ship it", spaceId: "space1", agentId: "naelao-agent", tenantId: "tenant1", userId: "user-a", projectId: "project-a", sessionId: "sess-1", runId: "run-1" }) }));
    return { response, body: await response.json() as Record<string, any> };
  };
  const raise = async (ceiling: number) => {
    const response = await instance.fetch(new Request("http://agent-do/goal-credit-ceiling", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent_run_id: "run-1", credit_ceiling: ceiling }) }));
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const settleResumes = async () => { await Promise.all(waiting.splice(0)); };
  const resumeRows = () => storage.sql.exec("SELECT status FROM goal_budget_resumes").toArray() as Array<{ status: string }>;
  return { instance, run, raise, settleResumes, dispatched, journals, credit, resumeRows, activity, storage };
}

// Each 20k-token task is estimated at 6 credits; the MS-25 snapshot sets the goal ceiling to 7, so task a is
// admitted and, once a has settled in full, task b is held.

describe("MS-26 budget-held goal resumes after the ceiling is raised (mock/local)", () => {
  beforeEach(() => { loop.calls = 0; loop.claimDone = "All done! The goal is complete."; });

  it("hold is a waiting outcome (never done), raise resumes the same journal once, settlement counted once", async () => {
    const f = await build(true);
    const first = await f.run();
    expect(first.body.status).toBe("awaiting_budget_approval");
    expect(first.body.pending_budget_approval).toMatchObject({ state: "awaiting_budget_approval", task_id: "b", tasks_completed: 1, tasks_total: 2 });
    expect(JSON.stringify(first.body)).not.toContain("All done");
    expect(f.dispatched).toEqual([expect.stringMatching(/:a$/)]);
    expect(f.credit()[0]).toMatchObject({ budget_state: "awaiting_budget_approval", credits_held: 0 });
    expect(Number(f.credit()[0]!.credits_settled)).toBeGreaterThan(0);
    const settledBefore = f.credit()[0]!.credits_settled;
    expect(f.resumeRows()).toEqual([{ status: "held" }]);
    // The run is waiting, using the existing waiting status for runs.
    const status = await f.instance.fetch(new Request("http://agent-do/script/run", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "ship it", spaceId: "space1", agentId: "naelao-agent", tenantId: "tenant1", userId: "user-a", projectId: "project-a", sessionId: "sess-1", runId: "run-1" }) }));
    expect((await status.json() as Record<string, any>).status).toBe("awaiting_approval");
    expect(normalizeScriptRunResult(first.body, "run-1")).toMatchObject({ status: "awaiting_approval", pending_budget_approval: { state: "awaiting_budget_approval" } });
    expect(normalizeScriptRunResult(first.body, "run-1").final_answer).toMatch(/awaiting budget approval/);
    expect(f.activity.some(row => row["event_type"] === "run_completed")).toBe(false);

    // Raise: resumes in the background through the same journal.
    const raised = await f.raise(1_000);
    expect(raised).toMatchObject({ status: 200, body: { ok: true, resume: "started" } });
    // A second, higher raise while the resume is in flight must not start a second execution.
    const second = await f.raise(2_000);
    expect(second.body.resume).toBe("not_needed");
    await f.settleResumes();
    expect(f.dispatched.map(id => id.split(":").at(-1))).toEqual(["a", "b"]);
    expect(f.journals()).toHaveLength(1);
    expect(Object.values(f.journals()[0].tasks).map((task: any) => task.status)).toEqual(["completed", "completed"]);
    expect(f.journals()[0].budgetHold).toBeUndefined();
    const after = f.credit()[0]!;
    expect(after).toMatchObject({ credit_ceiling: 2_000, budget_state: null, credits_held: 0 });
    expect(Number(after.credits_settled)).toBe(Number(settledBefore) * 2);
    expect(f.resumeRows()).toEqual([{ status: "resumed" }]);
    expect(loop.calls).toBe(1);
    // After completion a further raise only updates the ceiling.
    const third = await f.raise(3_000);
    expect(third.body.resume).toBe("not_needed");
    await f.settleResumes();
    expect(f.dispatched).toHaveLength(2);
    expect(f.credit()[0]).toMatchObject({ credit_ceiling: 3_000 });
  });

  it("a raise while the goal is not held only updates the ceiling", async () => {
    const f = await build(true);
    await f.run();
    // Raise once (resumes), let it finish, then raise again: nothing held, nothing dispatched.
    await f.raise(500);
    await f.settleResumes();
    const dispatched = f.dispatched.length;
    const again = await f.raise(900);
    await f.settleResumes();
    expect(again.body).toMatchObject({ ok: true, resume: "not_needed" });
    expect(f.dispatched).toHaveLength(dispatched);
  });

  it("flag off: no hold, no resume rows, unchanged route behavior", async () => {
    const f = await build(false);
    const result = await f.run();
    expect(result.body.status).not.toBe("awaiting_budget_approval");
    expect(result.body.pending_budget_approval).toBeUndefined();
    expect(f.dispatched.map(id => id.split(":").at(-1))).toEqual(["a", "b"]);
    expect(await f.raise(500).then(r => r.status)).toBe(404);
    expect(f.resumeRows()).toEqual([]);
  });
});
