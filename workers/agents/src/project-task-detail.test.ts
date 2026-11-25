import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim.js";
import { TaskDO } from "./do/TaskDO.js";
import { app } from "./index.js";

const secret = "project-task-detail-test-secret";
const spaceId = "space-a", tenantId = "tenant-a", userId = "user-a";

// The caller is a member of project-a only; project-b requests are refused by the Spaces worker.
async function harness() {
  const storage = Object.assign(createDOStorage(), { getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} });
  const taskDo = new TaskDO({ storage, waitUntil: () => {} } as never);
  const create = (id: string, projectId: string | null) => taskDo.fetch(new Request("http://task/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, space_id: spaceId, session_id: `thread-${id}`, tenant_id: tenantId, goal: "Do the work", ...(projectId ? { project_id: projectId } : {}) }) }));
  await create("task-a", "project-a");
  await create("task-b", "project-b");
  await create("task-none", null);
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare: (sql: string) => ({ bind: (..._args: unknown[]) => ({ first: async () =>
      sql.includes("FROM spaces") ? { id: spaceId } : null }) }) },
    SPACES_WORKER: { async fetch(input: Request | string) {
      const request = typeof input === "string" ? new Request(input) : input;
      return new URL(request.url).pathname.includes("/projects/project-a") ? Response.json({ project_id: "project-a" }) : new Response("no", { status: 404 });
    } },
    TASK_DO: { idFromName: (name: string) => name, get: () => ({ fetch: (input: string | Request, init?: RequestInit) => taskDo.fetch(typeof input === "string" ? new Request(input, init) : input) }) },
    WORKFLOW_RUN_DO: { idFromName: (name: string) => name, get: () => ({ existing: async () => null }) },
  } as never;
  return env;
}

async function get(taskId: string, env: never) {
  return app.request(`/spaces/${spaceId}/tasks/${taskId}`, { headers: { "x-naelao-tenant-id": tenantId, "x-naelao-user-id": userId,
    "x-naelao-role": "member", "x-naelao-internal-token": await mintInternalToken(secret, tenantId) } }, env);
}

describe("Project-scoped task detail (MS-13)", () => {
  it("denies a Space member reading another Project's task by ID, as not-found", async () => {
    const response = await get("task-b", await harness());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("returns the same shape for a missing task id and a denied one", async () => {
    const env = await harness();
    const missing = await get("task-missing", env);
    const denied = await get("task-b", env);
    expect(missing.status).toBe(denied.status);
  });

  it("lets a Project member read their own Project's task", async () => {
    const response = await get("task-a", await harness());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ task_id: "task-a", project_id: "project-a" });
  });

  it("still lets a Space member read a task with no project_id", async () => {
    const response = await get("task-none", await harness());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ task_id: "task-none" });
  });
});
