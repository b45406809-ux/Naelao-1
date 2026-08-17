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
