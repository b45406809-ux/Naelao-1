import { describe, it, expect, beforeEach } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// Security audit follow-up (observability gap): a builder had no way to see what their agent has
// actually been doing — no run history, no cost, no visibility into why it escalated. agent_runs
// lives inside NaelaoAgentDO, one DO per (space, project, thread), so querying it product-wide
// would mean opening every single agent DO — the same "doesn't scale" problem
// business_memberships/threads-mirroring already solved elsewhere. SpaceDO's agent_activity_log
// is the mirrored, product-wide, paginated read surface this exercises directly over real
// in-memory SQLite (node:sqlite), the same rigor as spacedo-project-spend.test.ts.

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

describe("SpaceDO — /agent-activity (builder observability surface)", () => {
  let spaceDO: SpaceDO;

  beforeEach(() => {
    spaceDO = makeSpaceDO();
  });

  it("400s on a write missing required fields", async () => {
    const res = await call(spaceDO, "/agent-activity", "POST", { space_id: "space1" });
    expect(res.status).toBe(400);
  });

  it("records a run_completed event and lists it back newest-first", async () => {
    const write = await call(spaceDO, "/agent-activity", "POST", {
      space_id: "space1", agent_id: "naelao-agent", event_type: "run_completed",
      summary: "Answered a question", tokens_used: 1200, cost_credits: 15,
    });
    expect(write.status).toBe(201);

    const list = await call(spaceDO, "/agent-activity", "GET");
    expect(list.json.count).toBe(1);
    expect(list.json.data[0]).toMatchObject({
      agent_id: "naelao-agent", event_type: "run_completed", summary: "Answered a question",
      tokens_used: 1200, cost_credits: 15,
    });
  });

  it("filters by project_id", async () => {
    await call(spaceDO, "/agent-activity", "POST", { space_id: "space1", project_id: "proj-a", agent_id: "a1", event_type: "run_completed" });
    await call(spaceDO, "/agent-activity", "POST", { space_id: "space1", project_id: "proj-b", agent_id: "a1", event_type: "run_completed" });

    const listA = await call(spaceDO, "/agent-activity?project_id=proj-a", "GET");
    expect(listA.json.count).toBe(1);
    expect(listA.json.data[0].project_id).toBe("proj-a");
  });

  it("correlates Space Assistant, Project Assistant, and worker activity by root run", async () => {
    const rootRunId = "root-run-1";
    for (const row of [
      { assistant_scope: "project_assistant", project_id: "proj-a", run_id: rootRunId },
      { assistant_scope: "worker", project_id: "proj-a", run_id: "worker-run-1", root_run_id: rootRunId, parent_run_id: rootRunId, worker_id: "task-1" },
      { assistant_scope: "space_assistant", project_id: null, run_id: "root-run-2" },
    ]) {
      const { root_run_id: root, ...activity } = row;
      const result = await call(spaceDO, "/agent-activity", "POST", {
        space_id: "space1", agent_id: "naelao-agent", event_type: "run_completed",
        root_run_id: root ?? row.run_id, ...activity,
      });
      expect(result.status).toBe(201);
    }

    const trace = await call(spaceDO, `/agent-activity?root_run_id=${rootRunId}`, "GET");
    expect(trace.json.count).toBe(2);
    expect(trace.json.data.map((row: { assistant_scope: string }) => row.assistant_scope).sort()).toEqual(["project_assistant", "worker"]);
    expect(trace.json.data.find((row: { assistant_scope: string }) => row.assistant_scope === "worker")).toMatchObject({
      root_run_id: rootRunId, parent_run_id: rootRunId, worker_id: "task-1",
    });
  });

  it("rejects an overlong root-run filter rather than broadening the activity query", async () => {
    const response = await call(spaceDO, `/agent-activity?root_run_id=${"x".repeat(257)}`, "GET");
    expect(response.status).toBe(400);
    expect(response.json.error_code).toBe("invalid_root_run_id");
  });

  it("rejects incomplete or contradictory assistant-scope correlation", async () => {
    const missingWorkerScope = await call(spaceDO, "/agent-activity", "POST", {
      space_id: "space1", agent_id: "a1", event_type: "run_completed", assistant_scope: "worker",
    });
    expect(missingWorkerScope.status).toBe(400);
    expect(missingWorkerScope.json.error_code).toBe("incomplete_activity_correlation");

    const spaceWithProject = await call(spaceDO, "/agent-activity", "POST", {
      space_id: "space1", project_id: "proj-a", agent_id: "a1", event_type: "run_completed", assistant_scope: "space_assistant",
    });
    expect(spaceWithProject.status).toBe(400);
    expect(spaceWithProject.json.error_code).toBe("incomplete_activity_correlation");
  });

  it("respects a limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await call(spaceDO, "/agent-activity", "POST", { space_id: "space1", agent_id: "a1", event_type: "run_completed" });
    }
    const res = await call(spaceDO, "/agent-activity?limit=2", "GET");
    expect(res.json.count).toBe(2);
  });

  it("records approval_requested and run_failed event types too", async () => {
    await call(spaceDO, "/agent-activity", "POST", { space_id: "space1", agent_id: "a1", event_type: "approval_requested", summary: "wants to send an email" });
    await call(spaceDO, "/agent-activity", "POST", { space_id: "space1", agent_id: "a1", event_type: "run_failed", summary: "timed out" });

    const list = await call(spaceDO, "/agent-activity", "GET");
    const types = list.json.data.map((r: { event_type: string }) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(["approval_requested", "run_failed"]));
  });

  it("rejects an unrecognized event_type", async () => {
    const res = await call(spaceDO, "/agent-activity", "POST", { space_id: "space1", agent_id: "a1", event_type: "not_a_real_type" });
    expect(res.status).toBe(500); // CHECK constraint violation surfaces as a thrown error
  });
});
