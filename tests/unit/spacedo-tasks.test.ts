import { describe, it, expect, beforeEach } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// AVOS plan, step 4 — a per-project task DAG (migration v39), distinct from project_journal's
// own loose todos. Deliberately dumb CRUD at the SpaceDO layer — dependency-gate enforcement
// (task.start refusing to begin a task with unfinished dependencies) lives in the `tasks`
// prebuilt script (agents worker), not here; see tasks-prebuilt.test.ts for that.

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

describe("SpaceDO — tasks (migration v39, AVOS plan step 4)", () => {
  let spaceDO: SpaceDO;

  beforeEach(() => {
    spaceDO = makeSpaceDO();
  });

  it("creates a task with default status pending and empty dependencies", async () => {
    const created = await call(spaceDO, "/tasks", "POST", { space_id: "space1", title: "Write the report" });
    expect(created.status).toBe(201);
    expect(created.json.status).toBe("pending");
    expect(created.json.dependencies).toEqual([]);
    expect(created.json.assigned_agent).toBeNull();
  });

  it("rejects a task with no title", async () => {
    const res = await call(spaceDO, "/tasks", "POST", { space_id: "space1" });
    expect(res.status).toBe(400);
  });

  it("stores dependencies and assigned_agent, round-tripping through JSON", async () => {
    const created = await call(spaceDO, "/tasks", "POST", {
      space_id: "space1",
      project_id: "proj-1",
      title: "Deploy",
      dependencies: ["task-a", "task-b"],
      assigned_agent: "dev-agent",
    });
    expect(created.json.dependencies).toEqual(["task-a", "task-b"]);
    expect(created.json.assigned_agent).toBe("dev-agent");
  });

  it("rejects an unknown status", async () => {
    const res = await call(spaceDO, "/tasks", "POST", { space_id: "space1", title: "x", status: "done" });
    expect(res.status).toBe(400);
  });

  it("lists tasks scoped to a project, most-recently-created excluded from other projects", async () => {
    await call(spaceDO, "/tasks", "POST", { space_id: "space1", project_id: "proj-1", title: "A" });
    await call(spaceDO, "/tasks", "POST", { space_id: "space1", project_id: "proj-2", title: "B" });
    const listed = await call(spaceDO, "/tasks?space_id=space1&project_id=proj-1", "GET");
    expect(listed.json.count).toBe(1);
    expect(listed.json.data[0].title).toBe("A");
  });

  it("filters by status", async () => {
    const t1 = await call(spaceDO, "/tasks", "POST", { space_id: "space1", title: "A" });
    await call(spaceDO, "/tasks", "POST", { space_id: "space1", title: "B" });
    await call(spaceDO, `/tasks/${t1.json.id}`, "PATCH", { status: "completed" });
    const listed = await call(spaceDO, "/tasks?space_id=space1&status=completed", "GET");
    expect(listed.json.count).toBe(1);
    expect(listed.json.data[0].id).toBe(t1.json.id);
  });

  it("PATCH updates status/title/dependencies/assigned_agent independently", async () => {
    const t = await call(spaceDO, "/tasks", "POST", { space_id: "space1", title: "Original" });
    const updated = await call(spaceDO, `/tasks/${t.json.id}`, "PATCH", { status: "in_progress" });
    expect(updated.json.status).toBe("in_progress");
    expect(updated.json.title).toBe("Original"); // untouched

    const renamed = await call(spaceDO, `/tasks/${t.json.id}`, "PATCH", { title: "Renamed" });
    expect(renamed.json.title).toBe("Renamed");
    expect(renamed.json.status).toBe("in_progress"); // untouched
  });

  it("PATCH rejects an unknown status without touching the row", async () => {
    const t = await call(spaceDO, "/tasks", "POST", { space_id: "space1", title: "A" });
    const bad = await call(spaceDO, `/tasks/${t.json.id}`, "PATCH", { status: "nonsense" });
    expect(bad.status).toBe(400);
    const stillOk = await call(spaceDO, "/tasks?space_id=space1", "GET");
    expect(stillOk.json.data[0].status).toBe("pending");
  });

  it("PATCH on a nonexistent task 404s", async () => {
    const res = await call(spaceDO, "/tasks/does-not-exist", "PATCH", { status: "completed" });
    expect(res.status).toBe(404);
  });

  it("PATCH with nothing to update is a 400", async () => {
    const t = await call(spaceDO, "/tasks", "POST", { space_id: "space1", title: "A" });
    const res = await call(spaceDO, `/tasks/${t.json.id}`, "PATCH", {});
    expect(res.status).toBe(400);
  });

  it("DELETE removes the task; a second delete 404s", async () => {
    const t = await call(spaceDO, "/tasks", "POST", { space_id: "space1", title: "A" });
    const deleted = await call(spaceDO, `/tasks/${t.json.id}`, "DELETE", undefined);
    expect(deleted.status).toBe(200);
    const again = await call(spaceDO, `/tasks/${t.json.id}`, "DELETE", undefined);
    expect(again.status).toBe(404);
    const listed = await call(spaceDO, "/tasks?space_id=space1", "GET");
    expect(listed.json.count).toBe(0);
  });
});
