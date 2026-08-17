import { describe, it, expect, beforeEach } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// GET /agent-diagnostics — the whole-business summary the Space Assistant reads on a wake-up.
// Driven through the REAL SpaceDO (real migrations, real SQL) rather than a hand-rolled schema:
// this codebase has repeatedly shipped bugs where a test double's column names diverged from the
// actual migration (config_schema/schema_json, organizations/orgs), and this rollup depends on
// four columns that migration 36 adds to an already-existing table.

function makeSpaceDO(): SpaceDO {
  const ctx = { storage: createDOStorage() };
  const env = { PLATFORM_SECRET: "test-secret" };
  return new SpaceDO(ctx as never, env as never);
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

const SPACE = "space-1";

async function logActivity(spaceDO: SpaceDO, fields: Record<string, unknown>) {
  const res = await call(spaceDO, "/agent-activity", "POST", {
    space_id: SPACE,
    agent_id: "naelao-agent",
    ...fields,
  });
  expect(res.status).toBe(201);
}

describe("SpaceDO — /agent-diagnostics", () => {
  let spaceDO: SpaceDO;

  beforeEach(() => {
    spaceDO = makeSpaceDO();
  });

  it("returns a usable empty summary for a business that has done nothing yet", async () => {
    const { status, json } = await call(spaceDO, "/agent-diagnostics", "GET");
    expect(status).toBe(200);
    expect(json.runs.total).toBe(0);
    expect(json.runs.error_rate).toBe(0); // not NaN — a divide-by-zero here would poison the brief
    expect(json.failures_by_kind).toEqual([]);
    expect(json.recent_stalls).toEqual([]);
  });

  it("persists the classification and the ids needed to resume, then groups failures by kind", async () => {
    await logActivity(spaceDO, {
      event_type: "run_failed", failure_kind: "quota_exhausted",
      session_id: "sess-a", run_id: "run-a", trigger_source: "scheduled_job",
      summary: "4006 daily neuron allocation exceeded", tokens_used: 1200,
    });
    await logActivity(spaceDO, {
      event_type: "run_failed", failure_kind: "quota_exhausted",
      session_id: "sess-b", run_id: "run-b", trigger_source: "heartbeat", summary: "4006 again",
    });
    await logActivity(spaceDO, {
      event_type: "run_failed", failure_kind: "tool_error",
      session_id: "sess-c", run_id: "run-c", trigger_source: "chat", summary: "commerce.checkout failed",
    });
    await logActivity(spaceDO, { event_type: "run_completed", summary: "done", tokens_used: 300 });

    const { json } = await call(spaceDO, "/agent-diagnostics", "GET");
    expect(json.runs).toMatchObject({ total: 4, completed: 1, failed: 3 });
    expect(json.runs.error_rate).toBe(0.75);
    // Most common first — this ordering is what the brief's "most often: X" line depends on.
    expect(json.failures_by_kind[0]).toEqual({ kind: "quota_exhausted", count: 2 });
    expect(json.failures_by_kind[1]).toEqual({ kind: "tool_error", count: 1 });

    // The stall entries must carry the ids, or "go and continue that work" is not actionable.
    const stall = json.recent_stalls.find((s: any) => s.run_id === "run-a");
    expect(stall.session_id).toBe("sess-a");
    expect(stall.failure_kind).toBe("quota_exhausted");
    expect(stall.woken_by).toBe("scheduled_job");
    expect(stall.tokens_used).toBe(1200);
  });

  it("counts failed background wake-ups separately from chat failures", async () => {
    // A recurring "the heartbeat fires and immediately dies" pattern is invisible per-run and is
    // exactly what the owner needs told — a chat failure the person already saw is not.
    await logActivity(spaceDO, { event_type: "run_failed", trigger_source: "heartbeat", failure_kind: "quota_exhausted" });
    await logActivity(spaceDO, { event_type: "run_failed", trigger_source: "heartbeat", failure_kind: "quota_exhausted" });
    await logActivity(spaceDO, { event_type: "run_failed", trigger_source: "chat", failure_kind: "tool_error" });

    const { json } = await call(spaceDO, "/agent-diagnostics", "GET");
    expect(json.wake_failures).toEqual([{ trigger: "heartbeat", failed_runs: 2 }]);
  });

  it("resolves project names so the brief doesn't read as a list of uuids", async () => {
    const created = await call(spaceDO, "/projects", "POST", { space_id: SPACE, name: "Lead Generation" });
    expect(created.status).toBe(201);
    const projectId = created.json.id;

    await logActivity(spaceDO, { event_type: "run_failed", project_id: projectId, failure_kind: "tool_error", summary: "boom" });
    await logActivity(spaceDO, { event_type: "run_completed", project_id: projectId, summary: "ok" });

    const { json } = await call(spaceDO, "/agent-diagnostics", "GET");
    const project = json.projects.find((p: any) => p.project_id === projectId);
    expect(project.name).toBe("Lead Generation");
    expect(project).toMatchObject({ completed: 1, failed: 1 });
  });

  it("reports approvals still outstanding, which is parked work rather than broken work", async () => {
    await logActivity(spaceDO, { event_type: "approval_requested", summary: "payout" });
    await logActivity(spaceDO, { event_type: "approval_requested", summary: "outreach" });
    await logActivity(spaceDO, { event_type: "approval_resolved", summary: "payout approved" });

    const { json } = await call(spaceDO, "/agent-diagnostics", "GET");
    expect(json.approvals).toMatchObject({ requested: 2, resolved: 1, outstanding: 1 });
  });

  it("never reports a negative outstanding count when resolutions outnumber requests in the window", async () => {
    // Real case: an approval opened yesterday and resolved today, with a 24h window catching only
    // the resolution. A negative number in a brief reads as a bug and undermines the rest of it.
    await logActivity(spaceDO, { event_type: "approval_resolved", summary: "resolved" });
    const { json } = await call(spaceDO, "/agent-diagnostics", "GET");
    expect(json.approvals.outstanding).toBe(0);
  });

  it("surfaces unread notifications, and counts critical ones separately", async () => {
    await call(spaceDO, "/notifications", "POST", {
      space_id: SPACE, kind: "run_failed", title: "something broke", severity: "critical",
    });
    await call(spaceDO, "/notifications", "POST", {
      space_id: SPACE, kind: "info", title: "fyi", severity: "info",
    });

    const { json } = await call(spaceDO, "/agent-diagnostics", "GET");
    expect(json.notifications).toEqual({ unread: 2, unread_critical: 1 });
  });

  it("caps the stall list so a badly-broken business can't produce an unbounded brief", async () => {
    for (let i = 0; i < 20; i++) {
      await logActivity(spaceDO, {
        event_type: "run_failed", failure_kind: "tool_error", run_id: `run-${i}`, summary: `failure ${i}`,
      });
    }
    const { json } = await call(spaceDO, "/agent-diagnostics", "GET");
    expect(json.recent_stalls.length).toBeLessThanOrEqual(6);
    expect(json.runs.failed).toBe(20); // the count is still complete — only the detail list is capped
  });

  it("rejects an unknown failure_kind rather than storing free text in the classification column", async () => {
    // The whole rollup groups on this column; letting arbitrary strings in would fragment the
    // grouping and make "most common failure" meaningless.
    await logActivity(spaceDO, { event_type: "run_failed", failure_kind: "totally-made-up", summary: "x" });
    const { json } = await call(spaceDO, "/agent-diagnostics", "GET");
    expect(json.failures_by_kind).toEqual([{ kind: "unknown", count: 1 }]);
  });
});

describe("SpaceDO — /agent-activity drill-down filters", () => {
  let spaceDO: SpaceDO;

  beforeEach(async () => {
    spaceDO = makeSpaceDO();
    await logActivity(spaceDO, { event_type: "run_failed", failure_kind: "quota_exhausted", summary: "quota one" });
    await logActivity(spaceDO, { event_type: "run_failed", failure_kind: "tool_error", summary: "tool one" });
    await logActivity(spaceDO, { event_type: "run_completed", summary: "fine" });
  });

  it("filters to one failure kind — the step the overview points at", async () => {
    const { json } = await call(spaceDO, "/agent-activity?failure_kind=quota_exhausted", "GET");
    expect(json.count).toBe(1);
    expect(json.data[0].summary).toBe("quota one");
  });

  it("filters by event type", async () => {
    const { json } = await call(spaceDO, "/agent-activity?event_type=run_failed", "GET");
    expect(json.count).toBe(2);
  });

  it("ignores an unknown failure_kind filter instead of returning a silently empty list", async () => {
    // Returning [] for a typo'd filter would read as "nothing is wrong", which is the one wrong
    // answer here.
    const { json } = await call(spaceDO, "/agent-activity?failure_kind=nonsense", "GET");
    expect(json.count).toBe(3);
  });
});
