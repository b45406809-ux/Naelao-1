import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";

const DAY = 24 * 60 * 60 * 1000;

function setup(env: Record<string, string> = { RUN_LOG_RETENTION_ENABLED: "true" }) {
  const storage = createDOStorage();
  const agent = new NaelaoAgentDO({ storage, id: { toString: () => "agent-do" } } as never, env as never);
  (agent as unknown as { ensureInit(): void }).ensureInit();
  const sql = storage.sql;
  const prune = (now: number) => (agent as unknown as { pruneRunLogs(now: number): { walDeleted: number; tracesDeleted: number; checkpointsCleared: number } }).pruneRunLogs(now);
  const count = (table: string) => (sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray() as Array<{ n: number }>)[0]!.n;
  return { sql, prune, count };
}

function addTrace(sql: ReturnType<typeof setup>["sql"], runId: string, seq: number, ts: number) {
  sql.exec(`INSERT INTO run_traces (run_id, seq, phase, ts) VALUES (?, ?, 'run', ?)`, runId, seq, ts);
}

function addRunState(sql: ReturnType<typeof setup>["sql"], runId: string, terminal: boolean) {
  const now = Date.now();
  sql.exec(
    `INSERT INTO run_state (run_id, session_id, status, terminal_json, started_at, updated_at) VALUES (?, 's', ?, ?, ?, ?)`,
    runId, terminal ? "completed" : "running", terminal ? "{}" : null, now, now
  );
}

function addSubAgent(sql: ReturnType<typeof setup>["sql"], id: string, parentRunId: string, status: string, updatedAt: number) {
  sql.exec(
    `INSERT INTO sub_agents (id, parent_run_id, goal, status, checkpoint_json, updated_at) VALUES (?, ?, 'g', ?, '{"cp":1}', ?)`,
    id, parentRunId, status, updatedAt
  );
}

function checkpoint(sql: ReturnType<typeof setup>["sql"], id: string) {
  return (sql.exec(`SELECT checkpoint_json FROM sub_agents WHERE id = ?`, id).toArray() as Array<{ checkpoint_json: string | null }>)[0]!.checkpoint_json;
}

describe("run-log retention (MS-21, D9)", () => {
  it("removes run_traces rows older than 90 days and keeps 89-day rows", () => {
    const { sql, prune, count } = setup();
    const now = Date.now();
    addRunState(sql, "run-old", true);
    addTrace(sql, "run-old", 0, now - 91 * DAY);
    addTrace(sql, "run-old", 1, now - 89 * DAY);
    const counts = prune(now);
    expect(counts.tracesDeleted).toBe(1);
    expect(count("run_traces")).toBe(1);
    expect((sql.exec(`SELECT seq FROM run_traces`).toArray() as Array<{ seq: number }>)[0]!.seq).toBe(1);
  });

  it("removes old run_wal rows by finished_at (or started_at) and keeps pending rows", () => {
    const { sql, prune, count } = setup();
    const now = Date.now();
    const insertWal = (id: string, status: string, startedAt: number, finishedAt: number | null) =>
      sql.exec(`INSERT INTO run_wal (id, run_id, tool_name, tool_args, status, started_at, finished_at) VALUES (?, 'run-old', 't', '{}', ?, ?, ?)`, id, status, startedAt, finishedAt);
    insertWal("old-done", "done", now - 100 * DAY, now - 95 * DAY);
    insertWal("recent-finish", "done", now - 100 * DAY, now - 10 * DAY); // started long ago, finished recently
    insertWal("old-pending", "pending", now - 100 * DAY, null);
    const counts = prune(now);
    expect(counts.walDeleted).toBe(1);
    expect(count("run_wal")).toBe(2);
    const remaining = (sql.exec(`SELECT id FROM run_wal ORDER BY id`).toArray() as Array<{ id: string }>).map((r) => r.id);
    expect(remaining).toEqual(["old-pending", "recent-finish"]);
  });

  it("keeps every row of an active run, however old", () => {
    const { sql, prune, count } = setup();
    const now = Date.now();
    addRunState(sql, "run-live", false); // run_state with no terminal_json
    sql.exec(`INSERT INTO agent_runs (id, session_id, space_id, tenant_id, goal, status) VALUES ('run-legacy', 's', 'sp', 't', 'g', 'running')`);
    sql.exec(`INSERT INTO agent_runs (id, session_id, space_id, tenant_id, goal, status) VALUES ('run-waiting', 's', 'sp', 't', 'g', 'awaiting_approval')`);
    addTrace(sql, "run-live", 0, now - 200 * DAY);
    addTrace(sql, "run-legacy", 0, now - 200 * DAY);
    addTrace(sql, "run-waiting", 0, now - 200 * DAY);
    sql.exec(`INSERT INTO run_wal (id, run_id, tool_name, tool_args, status, started_at, finished_at) VALUES ('w1', 'run-live', 't', '{}', 'done', ?, ?)`, now - 200 * DAY, now - 200 * DAY);
    addSubAgent(sql, "sub-live-parent", "run-live", "done", now - 200 * DAY);
    const counts = prune(now);
    expect(counts).toEqual({ walDeleted: 0, tracesDeleted: 0, checkpointsCleared: 0 });
    expect(count("run_traces")).toBe(3);
    expect(count("run_wal")).toBe(1);
    expect(checkpoint(sql, "sub-live-parent")).toBe('{"cp":1}');
  });

  it("clears checkpoints only for old terminal workers, and keeps running, interrupted and recent ones", () => {
    const { sql, prune } = setup();
    const now = Date.now();
    addRunState(sql, "run-old", true);
    addSubAgent(sql, "done-old", "run-old", "done", now - 91 * DAY);
    addSubAgent(sql, "failed-old", "run-old", "failed", now - 91 * DAY);
    addSubAgent(sql, "terminated-old", "run-old", "terminated", now - 91 * DAY);
    addSubAgent(sql, "running-old", "run-old", "running", now - 200 * DAY);
    addSubAgent(sql, "interrupted-old", "run-old", "interrupted", now - 200 * DAY);
    addSubAgent(sql, "awaiting-old", "run-old", "awaiting_human_input", now - 200 * DAY);
    addSubAgent(sql, "done-recent", "run-old", "done", now - 89 * DAY);
    const counts = prune(now);
    expect(counts.checkpointsCleared).toBe(3);
    expect(checkpoint(sql, "done-old")).toBeNull();
    expect(checkpoint(sql, "failed-old")).toBeNull();
    expect(checkpoint(sql, "terminated-old")).toBeNull();
    expect(checkpoint(sql, "running-old")).toBe('{"cp":1}');
    expect(checkpoint(sql, "interrupted-old")).toBe('{"cp":1}');
    expect(checkpoint(sql, "awaiting-old")).toBe('{"cp":1}');
    expect(checkpoint(sql, "done-recent")).toBe('{"cp":1}');
    // Idempotent: a second pass has nothing left to clear.
    expect(prune(now).checkpointsCleared).toBe(0);
  });

  it("deletes at most 200 rows per table per pass and reports the first batch", () => {
    const { sql, prune, count } = setup();
    const now = Date.now();
    addRunState(sql, "run-old", true);
    for (let seq = 0; seq < 250; seq++) addTrace(sql, "run-old", seq, now - 120 * DAY);
    expect(prune(now).tracesDeleted).toBe(200);
    expect(count("run_traces")).toBe(50);
    expect(prune(now).tracesDeleted).toBe(50);
    expect(count("run_traces")).toBe(0);
  });

  it("removes nothing when the flag is off or unset", () => {
    for (const env of [{ RUN_LOG_RETENTION_ENABLED: "false" }, { RUN_LOG_RETENTION_ENABLED: "TRUE" }, {}]) {
      const { sql, prune, count } = setup(env);
      const now = Date.now();
      addRunState(sql, "run-old", true);
      addTrace(sql, "run-old", 0, now - 200 * DAY);
      addSubAgent(sql, "done-old", "run-old", "done", now - 200 * DAY);
      expect(prune(now)).toEqual({ walDeleted: 0, tracesDeleted: 0, checkpointsCleared: 0 });
      expect(count("run_traces")).toBe(1);
      expect(checkpoint(sql, "done-old")).toBe('{"cp":1}');
    }
  });
});
