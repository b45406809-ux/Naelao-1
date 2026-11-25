import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim.js";
import { TaskDO } from "./do/TaskDO.js";
import { app } from "./index.js";
import { executeGoalDag, type GoalDagHost, type GoalDagJournal } from "./script-engine/goal-dag.js";
import type { GoalTask } from "./script-engine/prebuilt/goal-planner.js";
import {
  admitGoalTaskDispatch, ensureGoalCreditSchema, estimateGoalTaskCredits, raiseGoalCreditCeiling,
  readGoalCreditState, settleGoalCreditReservation,
} from "./goal-credit-ceiling.js";

const KEY = "goal:test", PARENT = "run-1";
function sqlWithJournal() {
  const storage = createDOStorage();
  storage.sql.exec(`CREATE TABLE goal_dag_journals (journal_key TEXT PRIMARY KEY, journal_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  ensureGoalCreditSchema(storage.sql);
  ensureGoalCreditSchema(storage.sql); // idempotent migration
  storage.sql.exec("INSERT INTO goal_dag_journals(journal_key,journal_json,updated_at) VALUES(?,?,?)", KEY, "{}", 1);
  return storage.sql;
}
const admit = (sql: ReturnType<typeof sqlWithJournal>, taskId: string, credits: number) =>
  admitGoalTaskDispatch(sql, { journalKey: KEY, parentRunId: PARENT, taskId, reservationId: `r:${taskId}`, estimatedCredits: credits });

describe("goal credit ceiling accounting (MS-18)", () => {
  it("estimates a task from its token budget via tokensToCredits", () => {
    expect(estimateGoalTaskCredits(1800, "claude-sonnet-4-5")).toBeGreaterThanOrEqual(1);
    expect(() => estimateGoalTaskCredits(0, "claude-sonnet-4-5")).toThrow("goal_task_budget_invalid");
  });
  it("allows dispatch under the ceiling and blocks at it with a recorded reason", () => {
    const sql = sqlWithJournal();
    expect(admit(sql, "a", 120)).toEqual({ ok: true });
    expect(admit(sql, "b", 80)).toEqual({ ok: true }); // exactly 200 does not exceed
    const blocked = admit(sql, "c", 1);
    expect(blocked.ok).toBe(false);
    expect(readGoalCreditState(sql, KEY)).toMatchObject({ ceiling: 200, held: 200, settled: 0, state: "awaiting_budget_approval" });
    expect(readGoalCreditState(sql, KEY)?.reason).toContain("goal_credit_ceiling_would_be_exceeded");
  });
  it("re-admitting an existing reservation never double counts", () => {
    const sql = sqlWithJournal();
    admit(sql, "a", 150);
    expect(admit(sql, "a", 150)).toEqual({ ok: true });
    expect(readGoalCreditState(sql, KEY)?.held).toBe(150);
  });
  it("counts a duplicate settlement once and frees the hold", () => {
    const sql = sqlWithJournal();
    admit(sql, "a", 100);
    const settle = () => settleGoalCreditReservation(sql, { journalKey: KEY, reservationId: "r:a", tokensUsed: 500, budgetTokens: 1000 });
    expect(settle()).toBe(true);
    expect(settle()).toBe(false);
    expect(readGoalCreditState(sql, KEY)).toMatchObject({ settled: 50, held: 0 });
    expect(sql.exec<{ credits_settled: number; credits_held: number }>("SELECT credits_settled,credits_held FROM goal_dag_journals WHERE journal_key=?", KEY).toArray()[0])
      .toEqual({ credits_settled: 50, credits_held: 0 });
  });
  it("raising the ceiling clears the wait and admits the task; lowering is refused", () => {
    const sql = sqlWithJournal();
    admit(sql, "a", 190);
    expect(admit(sql, "b", 50).ok).toBe(false);
    expect(raiseGoalCreditCeiling(sql, { parentRunId: PARENT, ceiling: 100 })).toEqual({ ok: false, reason: "not_raised" });
    expect(raiseGoalCreditCeiling(sql, { parentRunId: PARENT, ceiling: 500 })).toEqual({ ok: true, raised: 1 });
    expect(readGoalCreditState(sql, KEY)).toMatchObject({ ceiling: 500, state: null, reason: null });
    expect(admit(sql, "b", 50)).toEqual({ ok: true });
    expect(raiseGoalCreditCeiling(sql, { parentRunId: "other", ceiling: 500 })).toEqual({ ok: false, reason: "not_found" });
    expect(raiseGoalCreditCeiling(sql, { parentRunId: PARENT, ceiling: 0 })).toEqual({ ok: false, reason: "invalid_ceiling" });
  });
});

const task = (id: string): GoalTask => ({ id, dependencies: [], title: id, subtask_spec: `do ${id}`, assigned_role: "schema-validator", file_paths: [`src/${id}.ts`], budget_tokens: 1800 });
function dagFixture(admitDispatch?: GoalDagHost["admitDispatch"]) {
  let saved: GoalDagJournal | undefined;
  const host: GoalDagHost = { concurrency: 1, workerId: id => `worker:${id}`,
    load: async () => saved && structuredClone(saved), save: async j => { saved = structuredClone(j); },
    publish: vi.fn(async () => undefined), recover: vi.fn(async () => undefined),
    launch: vi.fn(async (_t, id) => ({ id, ok: true })), ...(admitDispatch ? { admitDispatch } : {}) };
  return { host, snapshot: () => saved! };
}
describe("goal DAG dispatch gate (MS-18)", () => {
  it("flag off (no admitDispatch hook): dispatch is unchanged and no hold is recorded", async () => {
    const f = dagFixture();
    const journal = await executeGoalDag([task("a"), task("b")], f.host);
    expect(f.host.launch).toHaveBeenCalledTimes(2);
    expect(journal.budgetHold).toBeUndefined();
    expect(Object.values(journal.tasks).map(s => s.status)).toEqual(["completed", "completed"]);
  });
  it("blocks with awaiting_budget_approval, then resumes dispatch after the ceiling is raised", async () => {
    let allow = false;
    const f = dagFixture(async t => allow || t.id === "a" ? { ok: true } : { ok: false, reason: "goal_credit_ceiling_would_be_exceeded" });
    const first = await executeGoalDag([task("a"), task("b")], f.host);
    expect(first.tasks.a!.status).toBe("completed");
    expect(first.tasks.b!.status).toBe("pending");
    expect(first.budgetHold).toMatchObject({ state: "awaiting_budget_approval", taskId: "b" });
    expect(f.host.launch).toHaveBeenCalledTimes(1);
    allow = true; // ceiling raised
    const second = await executeGoalDag([task("a"), task("b")], f.host);
    expect(second.tasks.b!.status).toBe("completed");
    expect(second.budgetHold).toBeUndefined();
    expect(f.host.launch).toHaveBeenCalledTimes(2);
  });
});

const secret = "goal-credit-ceiling-test-secret";
const spaceId = "space-a", projectId = "project-a", tenantId = "tenant-a", userId = "user-a", sessionId = "thread-1";
async function harness(options: { flag?: string; projectRole?: "owner" | "editor" | "viewer"; orgRole?: string; taskProject?: string; agentStatus?: number } = {}) {
  const storage = Object.assign(createDOStorage(), { getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} });
  const taskDo = new TaskDO({ storage, waitUntil: () => {} } as never);
  await taskDo.fetch(new Request("http://task/tasks", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "task-1", space_id: spaceId, session_id: sessionId, tenant_id: tenantId, goal: "Goal", project_id: options.taskProject ?? projectId }) }));
  const agentCalls: Array<{ path: string; body: unknown }> = [];
  const env = {
    PLATFORM_SECRET: secret, ...(options.flag === undefined ? {} : { GOAL_CREDIT_CEILING_ENABLED: options.flag }),
    PLATFORM_DB: { prepare: (sql: string) => ({ bind: (..._a: unknown[]) => ({ first: async () =>
      sql.includes("FROM spaces") ? { id: spaceId } : sql.includes("FROM org_members") ? { role: options.orgRole ?? "owner" } : null }) }) },
    SPACES_WORKER: { async fetch(input: Request | string) {
      const request = typeof input === "string" ? new Request(input) : input;
      if (new URL(request.url).pathname.endsWith("/members")) return Response.json({ data: [{ user_id: userId, role: options.projectRole ?? "viewer" }] });
      return Response.json({ project_id: projectId });
    } },
    TASK_DO: { idFromName: (n: string) => n, get: () => ({ fetch: (i: string | Request, init?: RequestInit) => taskDo.fetch(typeof i === "string" ? new Request(i, init) : i) }) },
    NAELAO_AGENT_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async (request: Request) => {
      agentCalls.push({ path: new URL(request.url).pathname, body: await request.json() });
      return Response.json({ ok: true, goals_raised: 1 }, { status: options.agentStatus ?? 200 });
    } }) },
  } as never;
  return { env, agentCalls };
}
async function raise(env: never, role: string, body: unknown) {
  return app.request(`/spaces/${spaceId}/projects/${projectId}/goal-credit-ceiling`, { method: "POST", headers: { "content-type": "application/json",
    "x-naelao-tenant-id": tenantId, "x-naelao-user-id": userId, "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken(secret, tenantId) },
    body: JSON.stringify(body) }, env);
}
describe("goal credit ceiling raise route (MS-18)", () => {
  it("lets a Space owner raise the ceiling, forwarding the run id to the AgentDO", async () => {
    const f = await harness({ flag: "true" });
    const response = await raise(f.env, "owner", { task_id: "task-1", credit_ceiling: 500 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ task_id: "task-1", credit_ceiling: 500, dispatch_unblocked: true });
    expect(f.agentCalls).toEqual([{ path: "/goal-credit-ceiling", body: { parent_run_id: "task-1", credit_ceiling: 500 } }]);
  });
  it("lets a Project owner member raise it", async () => {
    const f = await harness({ flag: "true", projectRole: "owner", orgRole: "member" });
    expect((await raise(f.env, "member", { task_id: "task-1", credit_ceiling: 500 })).status).toBe(200);
  });
  it("answers the not-found shape for viewers, editors, foreign tasks and a flag-off worker", async () => {
    for (const options of [{ flag: "true", projectRole: "viewer" as const, orgRole: "member" }, { flag: "true", projectRole: "editor" as const, orgRole: "member" }]) {
      const f = await harness(options);
      const response = await raise(f.env, "member", { task_id: "task-1", credit_ceiling: 500 });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error_code: "not_found" });
      expect(f.agentCalls).toEqual([]);
    }
    const foreign = await harness({ flag: "true", taskProject: "project-b" });
    expect((await raise(foreign.env, "owner", { task_id: "task-1", credit_ceiling: 500 })).status).toBe(404);
    const off = await harness({ flag: "false" });
    const offResponse = await raise(off.env, "owner", { task_id: "task-1", credit_ceiling: 500 });
    expect(offResponse.status).toBe(404);
    expect(off.agentCalls).toEqual([]);
  });
  it("rejects an invalid ceiling for an authorized caller and maps a not-raised ceiling to 409", async () => {
    const f = await harness({ flag: "true" });
    expect((await raise(f.env, "owner", { task_id: "task-1", credit_ceiling: 0 })).status).toBe(400);
    const g = await harness({ flag: "true", agentStatus: 409 });
    expect((await raise(g.env, "owner", { task_id: "task-1", credit_ceiling: 5 })).status).toBe(409);
  });
});
