import { describe, expect, it, vi } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";

const secret = "ms25-secret";
const task = (id: string) => ({ id, dependencies: [], title: id, subtask_spec: id, assigned_role: "DEV_OPERATOR", file_paths: [`src/${id}.ts`], budget_tokens: 20_000 });

async function build(env: Record<string, unknown>, prefs: () => Response | Promise<Response>) {
  const kv = new Map<string, unknown>();
  const kvApi = { get: async (k: string) => kv.get(k), put: async (k: string, v: unknown) => { kv.set(k, v); }, delete: async (k: string) => kv.delete(k),
    list: async () => new Map(), transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(kvApi) };
  const storage = Object.assign(createDOStorage(), kvApi, { getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} });
  const fetched: string[] = [];
  const spaces = { fetch: async (r: Request) => {
    const u = new URL(r.url);
    if (u.pathname === "/internal/worker-preferences") { fetched.push(u.search); return prefs(); }
    return Response.json({ ok: true });
  } };
  const doInstance = new NaelaoAgentDO({ storage, id: { toString: () => "do-1" }, waitUntil: () => {} } as never,
    { PLATFORM_SECRET: secret, SPACES_WORKER: spaces, NAELAO_AGENT_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) }, ...env } as never);
  (doInstance as unknown as { ensureInit(): void }).ensureInit();
  const hooks = (doInstance as unknown as { buildOrchestrationHooks: (...a: unknown[]) => { executeGoalDag?: (o: string, t: unknown[]) => Promise<any> } })
    .buildOrchestrationHooks("space-a", "agent", "tenant-a", "key", "run-1", undefined, "project-a", undefined, "user-a", undefined, "claude-sonnet-4-6", "low", undefined);
  const journal = () => (storage.sql.exec("SELECT journal_json FROM goal_dag_journals").toArray() as Array<{ journal_json: string }>).map(r => JSON.parse(r.journal_json));
  const credit = () => storage.sql.exec("SELECT credit_ceiling,budget_state FROM goal_dag_journals").toArray() as Array<{ credit_ceiling: number; budget_state: string }>;
  return { hooks, fetched, journal, credit };
}
const stored = (ceiling: number) => Response.json({ space_limits: { max_workers: 1, allowed_model_tiers: null, goal_credit_ceiling: ceiling }, project_limits: null, user_preferences: null });
const flags = { GOAL_CREDIT_CEILING_ENABLED: "true" };

describe("goal start applies worker preferences (MS-25, mock/local)", () => {
  it("flag on: fetches once, stores the snapshot, applies the ceiling; a later change and a resume do not re-read", async () => {
    let ceiling = 1;
    const f = await build({ ...flags, WORKER_PREFERENCES_ENABLED: "true" }, () => stored(ceiling));
    expect(f.hooks.executeGoalDag).toBeTypeOf("function");
    const first = await f.hooks.executeGoalDag!("objective", [task("a")]);
    expect(f.fetched).toEqual(["?space_id=space-a&user_id=user-a&project_id=project-a"]);
    expect(first.preferences).toMatchObject({ workerCount: 1, goalCreditCeiling: 1 });
    expect(f.credit()).toEqual([{ credit_ceiling: 1, budget_state: "awaiting_budget_approval" }]);
    ceiling = 500;
    await f.hooks.executeGoalDag!("objective", [task("a")]);
    expect(f.fetched).toHaveLength(1);
    expect(f.journal()[0].preferences.goalCreditCeiling).toBe(1);
  });
  it("fetch failure records preferences_unavailable and keeps today's default ceiling", async () => {
    const f = await build({ ...flags, WORKER_PREFERENCES_ENABLED: "true" }, () => new Response("boom", { status: 500 }));
    const j = await f.hooks.executeGoalDag!("objective", [task("a")]).catch((e: Error) => { throw e; }).catch(() => undefined);
    const journal = f.journal()[0];
    expect(journal.preferences).toMatchObject({ unavailable: true, reason: "preferences_unavailable" });
    expect(f.credit()[0]!.credit_ceiling).toBe(200);
    void j;
  });
  it("flag off: no fetch and no snapshot", async () => {
    const f = await build({ ...flags }, () => stored(1));
    await f.hooks.executeGoalDag!("objective", [task("a")]).catch(() => undefined);
    expect(f.fetched).toHaveLength(0);
    expect(f.journal()[0]?.preferences).toBeUndefined();
  });
});
void vi;
