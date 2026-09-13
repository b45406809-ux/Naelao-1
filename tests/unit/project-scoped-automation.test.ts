import { describe, expect, it } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

async function fixture() {
  const storage = createDOStorage();
  const instance = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "test" } as never);
  await instance.fetch(new Request("http://space-do/projects?space_id=space-a"));
  storage.sql.exec("INSERT INTO projects (id, space_id, name, description, status, visibility, created_at) VALUES (?, ?, ?, '', 'active', 'private', datetime('now'))", "project-a", "space-a", "A");
  storage.sql.exec("INSERT INTO projects (id, space_id, name, description, status, visibility, created_at) VALUES (?, ?, ?, '', 'active', 'private', datetime('now'))", "project-b", "space-b", "B");
  storage.sql.exec("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, 'editor', datetime('now'))", "project-a", "editor");
  const call = (path: string, method = "GET", body?: unknown) => instance.fetch(new Request(`http://space-do${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  return { call };
}

describe("project-scoped automation", () => {
  it("rejects missing, nonexistent, and cross-space project ids before trigger persistence", async () => {
    const { call } = await fixture();
    const base = { space_id: "space-a", event_type: "thread.created", script_name: "notify" };
    expect((await call("/event-triggers", "POST", base)).status).toBe(400);
    expect((await call("/event-triggers", "POST", { ...base, project_id: "missing" })).status).toBe(404);
    expect((await call("/event-triggers", "POST", { ...base, project_id: "project-b" })).status).toBe(404);
  });

  it("denies a private-project outsider and permits an authorized editor", async () => {
    const { call } = await fixture();
    expect((await call("/projects/project-a/automation-access?space_id=space-a&user_id=outsider")).status).toBe(403);
    expect((await call("/projects/project-a/automation-access?space_id=space-a&user_id=editor")).status).toBe(200);
    const created = await call("/event-triggers", "POST", { project_id: "project-a", space_id: "space-a", event_type: "thread.created", script_name: "notify" });
    expect(created.status).toBe(201);
    expect((await created.json() as { project_id: string }).project_id).toBe("project-a");
  });
});
