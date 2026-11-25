import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim.js";
import { TaskDO } from "./do/TaskDO.js";
import { app } from "./index.js";

const secret = "project-task-stop-test-secret";
const spaceId = "space-a", projectId = "project-a", tenantId = "tenant-a", userId = "user-a", sessionId = "thread-1";

type AgentReply = (url: string) => Response | Promise<Response>;

async function harness(options: { agent?: AgentReply; projectRole?: "owner" | "editor" | "viewer"; orgRole?: string; taskProject?: string; status?: "processing" | "complete" } = {}) {
  const storage = Object.assign(createDOStorage(), { getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} });
  const taskDo = new TaskDO({ storage, waitUntil: () => {} } as never);
  const call = (path: string, method = "GET", body?: unknown) => taskDo.fetch(new Request(`http://task${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  await call("/tasks", "POST", { id: "task-1", space_id: spaceId, session_id: sessionId, tenant_id: tenantId, goal: "Do the work", project_id: options.taskProject ?? projectId });
  await call("/tasks/task-1/status", "PUT", { status: "processing" });
  if (options.status === "complete") await call("/tasks/task-1/status", "PUT", { status: "complete", result: "{}" });

  const agentCalls: string[] = [];
  const agentReply: AgentReply = options.agent ?? (url => Response.json({ id: "task-1", status: "cancelling" }));
  const workflowCancel = vi.fn(async () => Response.json({ ok: true }));
  const workflowExisting = vi.fn(async () => null);
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare: (sql: string) => ({ bind: (..._args: unknown[]) => ({ first: async () =>
      sql.includes("FROM spaces") ? { id: spaceId } : sql.includes("FROM org_members") ? { role: options.orgRole ?? "owner" } : null }) }) },
    SPACES_WORKER: { async fetch(input: Request | string) {
      const request = typeof input === "string" ? new Request(input) : input;
      if (new URL(request.url).pathname.endsWith("/members")) return Response.json({ data: [{ user_id: userId, role: options.projectRole ?? "viewer" }] });
      return Response.json({ project_id: projectId });
    } },
    TASK_DO: { idFromName: (name: string) => name, get: () => ({ fetch: (input: string | Request, init?: RequestInit) => taskDo.fetch(typeof input === "string" ? new Request(input, init) : input) }) },
    NAELAO_AGENT_DO: { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async (request: Request) => {
      agentCalls.push(`${name.endsWith(":voice-control") ? "voice:" : ""}${request.method} ${new URL(request.url).pathname}`);
      return agentReply(request.url);
    } }) },
    WORKFLOW_RUN_DO: { idFromName: (name: string) => name, get: () => ({ cancel: workflowCancel, existing: workflowExisting, fetch: workflowCancel }) },
  } as never;
  return { env, agentCalls, workflowCancel, call };
}

async function request(path: string, env: never, role: string, method: "GET" | "POST" = "POST", body?: unknown) {
  return app.request(path, { method, headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
    "x-naelao-user-id": userId, "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken(secret, tenantId) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
}

const stopPath = `/spaces/${spaceId}/projects/${projectId}/task-stop`;

describe("Project task stop (MS-07)", () => {
  it("lets a Space owner stop a running task, forwarding to the AgentDO run id and writing a stopped receipt", async () => {
    const f = await harness();
    const response = await request(stopPath, f.env, "owner", "POST", { task_id: "task-1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ task_id: "task-1", outcome: "stopped", status: "processing", receipt: { action: "stop", outcome: "stopped", requested_by: userId } });
    expect(f.agentCalls).toEqual(["POST /runs/task-1/cancel"]);
    const detail = await request(`/spaces/${spaceId}/tasks/task-1`, f.env, "owner", "GET");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ status: "processing", latest_control_receipt: { outcome: "stopped", action: "stop" } });
    expect(f.workflowCancel).not.toHaveBeenCalled();
  });

  it("lets a Project owner member who is not a Space owner or admin stop the task", async () => {
    const f = await harness({ projectRole: "owner", orgRole: "member" });
    const response = await request(stopPath, f.env, "member", "POST", { task_id: "task-1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "stopped" });
    expect(f.agentCalls).toHaveLength(1);
    expect(f.workflowCancel).not.toHaveBeenCalled();
  });

  it.each([["viewer"], ["editor"]] as const)("denies a Project %s with 403 and never contacts the run", async role => {
    const f = await harness({ projectRole: role, orgRole: "member" });
    const response = await request(stopPath, f.env, role, "POST", { task_id: "task-1" });
    expect(response.status).toBe(403);
    expect(f.agentCalls).toEqual([]);
    expect(f.workflowCancel).not.toHaveBeenCalled();
    expect((await (await f.call("/tasks/task-1")).json() as Record<string, unknown>).latest_control_receipt).toBeUndefined();
  });

  it("returns 404 for a task that belongs to another Project", async () => {
    const f = await harness({ taskProject: "project-b" });
    const response = await request(stopPath, f.env, "owner", "POST", { task_id: "task-1" });
    expect(response.status).toBe(404);
    expect(f.agentCalls).toEqual([]);
    expect((await (await f.call("/tasks/task-1")).json() as Record<string, unknown>).latest_control_receipt).toBeUndefined();
  });

  it("records already_terminal for a completed task without contacting the run", async () => {
    const f = await harness({ status: "complete" });
    const response = await request(stopPath, f.env, "owner", "POST", { task_id: "task-1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "already_terminal", status: "complete", receipt: { outcome: "already_terminal" } });
    expect(f.agentCalls).toEqual([]);
    expect(f.workflowCancel).not.toHaveBeenCalled();
  });

  it.each([
    ["an unreachable AgentDO", () => { throw new Error("agent down"); }],
    ["an AgentDO that rejects the stop", () => Response.json({ error_code: "bad_request" }, { status: 400 })],
  ] as const)("records uncertain and leaves the task unchanged for %s", async (_name, agent) => {
    const f = await harness({ agent });
    const response = await request(stopPath, f.env, "owner", "POST", { task_id: "task-1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "uncertain", status: "processing", receipt: { outcome: "uncertain" } });
    expect(await (await f.call("/tasks/task-1")).json()).toMatchObject({ status: "processing", latest_control_receipt: { outcome: "uncertain" } });
    expect(f.workflowCancel).not.toHaveBeenCalled();
  });

  it("uses the same voice-control fallback as the conversation stop", async () => {
    let calls = 0;
    const f = await harness({ agent: () => ++calls === 1 ? Response.json({ error_code: "not_found" }, { status: 404 }) : Response.json({ id: "task-1", status: "cancelling" }) });
    const response = await request(stopPath, f.env, "owner", "POST", { task_id: "task-1" });
    expect(await response.json()).toMatchObject({ outcome: "stopped" });
    expect(f.agentCalls).toEqual(["POST /runs/task-1/cancel", "voice:POST /runs/task-1/cancel"]);
  });

  it("rejects a malformed body", async () => {
    const f = await harness();
    expect((await request(stopPath, f.env, "owner", "POST", {})).status).toBe(400);
  });
});
