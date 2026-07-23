import { describe, it, expect } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// §A1 Harness Excellence Phase HX2: explicit signals (computed on read from the pre-existing
// agent_activity_log), implicit signal events (a new table), and the session token-budget
// guard's tally (session_spend) — all exercised directly against the DO's real fetch() router.

function makeSpaceDO(env: Record<string, unknown> = {}): SpaceDO {
  const ctx = { storage: createDOStorage() };
  return new SpaceDO(ctx as never, { PLATFORM_SECRET: "test-secret", ...env } as never);
}

async function call(doInstance: SpaceDO, path: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await doInstance.fetch(
    new Request(`http://space-do${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

async function logActivity(doInstance: SpaceDO, overrides: Record<string, unknown> = {}) {
  return call(doInstance, "/agent-activity", "POST", {
    space_id: "space-1",
    agent_id: "naelao-agent",
    event_type: "run_completed",
    cost_credits: 10,
    ...overrides,
  });
}

describe("GET /agent-signals — explicit signals computed from agent_activity_log", () => {
  it("returns all zeros when there is no activity yet", async () => {
    const doInstance = makeSpaceDO();
    const res = await call(doInstance, "/agent-signals", "GET");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ runs_total: 0, runs_completed: 0, runs_failed: 0, error_rate: 0, approvals_requested: 0, regenerations: 0 });
  });

  it("computes error_rate and avg/total cost from completed + failed runs", async () => {
    const doInstance = makeSpaceDO();
    await logActivity(doInstance, { cost_credits: 10 });
    await logActivity(doInstance, { cost_credits: 20 });
    await logActivity(doInstance, { event_type: "run_failed", cost_credits: null });
    const res = await call(doInstance, "/agent-signals", "GET");
    expect(res.json.runs_total).toBe(3);
    expect(res.json.runs_completed).toBe(2);
    expect(res.json.runs_failed).toBe(1);
    expect(res.json.error_rate).toBeCloseTo(1 / 3);
    expect(res.json.avg_cost_credits).toBe(15);
    expect(res.json.total_cost_credits).toBe(30);
  });

  it("counts approval_requested events separately from run outcomes", async () => {
    const doInstance = makeSpaceDO();
    await logActivity(doInstance, { event_type: "approval_requested", cost_credits: null, summary: "send_email" });
    const res = await call(doInstance, "/agent-signals", "GET");
    expect(res.json.approvals_requested).toBe(1);
    expect(res.json.runs_total).toBe(0);
  });

  it("filters by project_id when provided", async () => {
    const doInstance = makeSpaceDO();
    await logActivity(doInstance, { project_id: "proj-a" });
    await logActivity(doInstance, { project_id: "proj-b" });
    const res = await call(doInstance, "/agent-signals?project_id=proj-a", "GET");
    expect(res.json.runs_total).toBe(1);
  });

  it("counts a regeneration when the SAME thread has 2 run events within 5 minutes", async () => {
    const doInstance = makeSpaceDO();
    // ensureInit() runs lazily inside fetch() — trigger it before touching sql directly.
    await call(doInstance, "/agent-signals", "GET");
    const sql = (doInstance as unknown as { ctx: { storage: { sql: { exec: (q: string, ...a: unknown[]) => unknown } } } }).ctx.storage.sql;
    // Insert two rows on the same thread 1 minute apart (within the 5-minute regen window),
    // timestamped relative to SQLite's own `now` so they always fall inside the query window
    // regardless of what the test runner's wall-clock date happens to be.
    sql.exec(
      `INSERT INTO agent_activity_log (id, space_id, thread_id, agent_id, event_type, cost_credits, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-10 minutes'))`,
      "row-1", "space-1", "thread-a", "naelao-agent", "run_completed", 5
    );
    sql.exec(
      `INSERT INTO agent_activity_log (id, space_id, thread_id, agent_id, event_type, cost_credits, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-9 minutes'))`,
      "row-2", "space-1", "thread-a", "naelao-agent", "run_completed", 5
    );
    const res = await call(doInstance, "/agent-signals?window_hours=1", "GET");
    expect(res.json.regenerations).toBe(1);
  });
});

describe("signal-events (implicit signals)", () => {
  it("rejects a record missing required fields", async () => {
    const doInstance = makeSpaceDO();
    const res = await call(doInstance, "/signal-events", "POST", { space_id: "space-1" });
    expect(res.status).toBe(400);
  });

  it("records and lists a signal event", async () => {
    const doInstance = makeSpaceDO();
    const record = await call(doInstance, "/signal-events", "POST", {
      space_id: "space-1", project_id: "proj-1", thread_id: "sess-1", agent_id: "naelao-agent",
      signal_type: "user_frustration", detail: "that's wrong",
    });
    expect(record.status).toBe(201);
    const list = await call(doInstance, "/signal-events", "GET");
    expect(list.json.count).toBe(1);
    expect(list.json.data[0].signal_type).toBe("user_frustration");
  });

  it("filters by signal_type", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/signal-events", "POST", { space_id: "space-1", agent_id: "a1", signal_type: "user_frustration" });
    await call(doInstance, "/signal-events", "POST", { space_id: "space-1", agent_id: "a1", signal_type: "agent_forgot" });
    const res = await call(doInstance, "/signal-events?signal_type=agent_forgot", "GET");
    expect(res.json.count).toBe(1);
    expect(res.json.data[0].signal_type).toBe("agent_forgot");
  });
});

describe("session-spend (session token-budget guard tally)", () => {
  it("reads a zeroed default for a session with no spend yet", async () => {
    const doInstance = makeSpaceDO();
    const res = await call(doInstance, "/session-spend/sess-unknown", "GET");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ session_id: "sess-unknown", credits_used: 0, warned_80: false });
  });

  it("increments across multiple calls (upsert, not overwrite)", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/session-spend", "POST", { session_id: "sess-1", space_id: "space-1", credits: 30 });
    await call(doInstance, "/session-spend", "POST", { session_id: "sess-1", space_id: "space-1", credits: 20 });
    const res = await call(doInstance, "/session-spend/sess-1", "GET");
    expect(res.json.credits_used).toBe(50);
  });

  it("mark-warned sets warned_80 idempotently", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/session-spend", "POST", { session_id: "sess-2", space_id: "space-1", credits: 80 });
    await call(doInstance, "/session-spend/sess-2/mark-warned", "POST");
    const res1 = await call(doInstance, "/session-spend/sess-2", "GET");
    expect(res1.json.warned_80).toBe(true);
    // Calling again is a no-op, not an error.
    await call(doInstance, "/session-spend/sess-2/mark-warned", "POST");
    const res2 = await call(doInstance, "/session-spend/sess-2", "GET");
    expect(res2.json.warned_80).toBe(true);
  });

  it("continue resets credits_used and warned_80 for a fresh spending cycle", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/session-spend", "POST", { session_id: "sess-3", space_id: "space-1", credits: 100 });
    await call(doInstance, "/session-spend/sess-3/mark-warned", "POST");
    await call(doInstance, "/session-spend/sess-3/continue", "POST");
    const res = await call(doInstance, "/session-spend/sess-3", "GET");
    expect(res.json.credits_used).toBe(0);
    expect(res.json.warned_80).toBe(false);
  });

  it("continue on a session with no prior spend is a harmless no-op", async () => {
    const doInstance = makeSpaceDO();
    const res = await call(doInstance, "/session-spend/sess-never-spent/continue", "POST");
    expect(res.status).toBe(200);
    const read = await call(doInstance, "/session-spend/sess-never-spent", "GET");
    expect(read.json.credits_used).toBe(0);
  });

  it("negative credits are floored to 0 (never decrements below the current tally accidentally)", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/session-spend", "POST", { session_id: "sess-4", space_id: "space-1", credits: -50 });
    const res = await call(doInstance, "/session-spend/sess-4", "GET");
    expect(res.json.credits_used).toBe(0);
  });
});
