import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";

const DAY = 24 * 60 * 60 * 1000;
const MARKER = "worker-branch-retire-pending:w1";

function setup(env: Record<string, unknown> = {}, coordinator: "ok" | "error" = "ok") {
  const base = createDOStorage();
  const kv = new Map<string, unknown>();
  const storage = Object.assign(base, {
    async get<T>(key: string) { return kv.get(key) as T | undefined; },
    async put(key: string, value: unknown) { kv.set(key, value); },
    async delete(key: string) { return kv.delete(key); },
    async list<T>(options: { prefix?: string; limit?: number } = {}) {
      const out = new Map<string, T>();
      for (const [key, value] of [...kv.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (options.prefix && !key.startsWith(options.prefix)) continue;
        if (options.limit && out.size >= options.limit) break;
        out.set(key, value as T);
      }
      return out;
    },
  });
  const retires: Array<Record<string, unknown>> = [];
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path !== "/v1/branch/retire") return Response.json({ error_code: "not_found" }, { status: 404 });
    retires.push(await request.json() as Record<string, unknown>);
    return coordinator === "error" ? Response.json({ error_code: "boom" }, { status: 503 }) : Response.json({ retired: true });
  } }) };
  const agent = new NaelaoAgentDO({ storage, id: { toString: () => "agent-do" } } as never,
    { UNIFIED_WORKSPACE_ENABLED: "true", WORKSPACE_COORDINATOR: namespace, PLATFORM_SECRET: "secret", ...env } as never);
  (agent as unknown as { ensureInit(): void }).ensureInit();
  const sql = storage.sql;
  const seedWorker = (id: string, branch: string | null) => sql.exec(
    `INSERT INTO sub_agents (id, parent_run_id, goal, status, workspace_branch, configuration_json, updated_at) VALUES (?, 'p', 'g', 'terminated', ?, ?, ?)`,
    id, branch, JSON.stringify({ tenantId: "tenant", spaceId: "space", projectId: "project" }), Date.now());
  const count = (table: string) => (sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray() as Array<{ n: number }>)[0]!.n;
  return { agent, storage, kv, retires, seedWorker, sql, count };
}

describe("MS-48 AgentDO alarm retention", () => {
  it("retries a pending worker-branch retire marker from the alarm and clears it on success", async () => {
    const { agent, kv, retires, seedWorker } = setup({ WORKER_BRANCH_RETENTION_ENABLED: "true" });
    seedWorker("w1", "workers/w1");
    kv.set(MARKER, { outcome: "ended", at: 1234, attempts: 1, nextAt: 0 });
    await agent.alarm();
    expect(retires).toHaveLength(1);
    expect(retires[0]).toMatchObject({ branch: "workers/w1", outcome: "ended", endedAt: 1234 });
    expect(kv.has(MARKER)).toBe(false);
  });

  it("backs off after a failed retry, does not spin, and drops markers for vanished workers", async () => {
    const { agent, kv, retires, seedWorker } = setup({ WORKER_BRANCH_RETENTION_ENABLED: "true" }, "error");
    seedWorker("w1", "workers/w1");
    kv.set(MARKER, { outcome: "published", at: 50, attempts: 1, nextAt: 0 });
    kv.set("worker-branch-retire-pending:gone", { outcome: "ended", at: 50, attempts: 1, nextAt: 0 });
    await agent.alarm();
    expect(retires).toHaveLength(1);
    const marker = kv.get(MARKER) as { attempts: number; nextAt: number; at: number };
    expect(marker.attempts).toBe(2);
    expect(marker.at).toBe(50);
    expect(marker.nextAt).toBeGreaterThan(Date.now());
    expect(kv.has("worker-branch-retire-pending:gone")).toBe(false);
    await agent.alarm();
    expect(retires).toHaveLength(1);
  });

  it("gives up on a marker after the maximum number of attempts", async () => {
    const { agent, kv, retires, seedWorker } = setup({ WORKER_BRANCH_RETENTION_ENABLED: "true" }, "error");
    seedWorker("w1", "workers/w1");
    kv.set(MARKER, { outcome: "ended", at: 50, attempts: 12, nextAt: 0 });
    await agent.alarm();
    expect(retires).toHaveLength(0);
    expect(kv.has(MARKER)).toBe(false);
  });

  it("flag off leaves markers untouched", async () => {
    const { agent, kv, retires, seedWorker } = setup({});
    seedWorker("w1", "workers/w1");
    const marker = { outcome: "ended", at: 1, attempts: 1, nextAt: 0 };
    kv.set(MARKER, marker);
    await agent.alarm();
    expect(retires).toHaveLength(0);
    expect(kv.get(MARKER)).toEqual(marker);
  });

  it("prunes run logs from the alarm, then waits a day before pruning again", async () => {
    const { agent, kv, sql, count } = setup({ RUN_LOG_RETENTION_ENABLED: "true" });
    const old = Date.now() - 100 * DAY;
    sql.exec(`INSERT INTO run_traces (run_id, seq, phase, ts) VALUES ('r1', 0, 'run', ?)`, old);
    await agent.alarm();
    expect(count("run_traces")).toBe(0);
    const next = kv.get("run-log-prune:next-at") as number;
    expect(next).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    sql.exec(`INSERT INTO run_traces (run_id, seq, phase, ts) VALUES ('r2', 0, 'run', ?)`, old);
    await agent.alarm();
    expect(count("run_traces")).toBe(1);
    kv.set("run-log-prune:next-at", Date.now() - 1);
    await agent.alarm();
    expect(count("run_traces")).toBe(0);
  });

  it("the alarm re-arms for idle retention work and does nothing with the flags off", async () => {
    const on = setup({ RUN_LOG_RETENTION_ENABLED: "true" });
    await on.agent.alarm();
    expect(await on.storage.getAlarm()).not.toBeNull();
    const off = setup({});
    off.sql.exec(`INSERT INTO run_traces (run_id, seq, phase, ts) VALUES ('r1', 0, 'run', ?)`, Date.now() - 100 * DAY);
    await off.agent.alarm();
    expect(off.count("run_traces")).toBe(1);
    expect(off.kv.has("run-log-prune:next-at")).toBe(false);
    expect(await off.storage.getAlarm()).toBeNull();
  });
});
