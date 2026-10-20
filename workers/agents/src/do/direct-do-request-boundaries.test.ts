import { describe, expect, it, vi } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { HITLApprovalDO } from "./HITLApprovalDO.js";
import { TaskDO } from "./TaskDO.js";

function overLimitBody(bytes: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

describe("direct task and approval DO request bounds", () => {
  it("rejects an oversized TaskDO body before migrations or parsing", async () => {
    const storage = createDOStorage();
    const task = new TaskDO({ storage } as never);
    const response = await task.fetch(
      new Request("http://task/tasks", {
        method: "POST",
        body: overLimitBody(1024 * 1024 + 1),
        duplex: "half",
      } as RequestInit)
    );
    expect(response.status).toBe(413);
    expect(
      storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table'")
        .toArray()
    ).toHaveLength(0);
  });

  it("rejects an oversized HITLApprovalDO body before migrations or parsing", async () => {
    const storage = createDOStorage();
    const approval = new HITLApprovalDO({ storage } as never, {} as never);
    const response = await approval.fetch(
      new Request("http://approval/requests", {
        method: "POST",
        body: overLimitBody(2 * 1024 * 1024 + 1),
        duplex: "half",
      } as RequestInit)
    );
    expect(response.status).toBe(413);
    expect(
      storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table'")
        .toArray()
    ).toHaveLength(0);
  });
});

function taskHarness() {
  const storage = Object.assign(createDOStorage(), {
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  });
  const pending: Promise<unknown>[] = [];
  const task = new TaskDO({ storage, waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as never);
  return { task, storage, pending };
}

async function taskCall(task: TaskDO, path: string, method = "GET", body?: unknown) {
  return task.fetch(new Request(`http://task${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

const taskBody = (extra: Record<string, unknown> = {}) => ({
  id: "task-1", space_id: "space-1", session_id: "thread-1", tenant_id: "tenant-1", goal: "Do the work", ...extra,
});

describe("TaskDO state and callback boundaries", () => {
  it("rejects malformed creation and callback destinations before persisting a task", async () => {
    const { task, storage } = taskHarness();
    expect((await taskCall(task, "/tasks", "POST", null)).status).toBe(400);
    expect((await taskCall(task, "/tasks", "POST", taskBody({ callback_url: "http://example.com/hook" }))).status).toBe(400);
    expect((await taskCall(task, "/tasks", "POST", taskBody({ callback_url: "https://127.0.0.1/hook" }))).status).toBe(400);
    expect((await taskCall(task, "/tasks", "POST", taskBody({ callback_url: "https://user:secret@example.com/hook" }))).status).toBe(400);
    expect(storage.sql.exec("SELECT id FROM tasks").toArray()).toHaveLength(0);
  });

  it("does not let a repeated task ID replace the original workflow state", async () => {
    const { task } = taskHarness();
    expect((await taskCall(task, "/tasks", "POST", taskBody())).status).toBe(201);
    expect((await taskCall(task, "/tasks/task-1/status", "PUT", { status: "processing" })).status).toBe(200);
    expect((await taskCall(task, "/tasks", "POST", taskBody({ goal: "Replace the task" }))).status).toBe(409);
    expect((await (await taskCall(task, "/tasks/task-1")).json()).status).toBe("processing");
  });

  it("validates task statuses/results and suppresses duplicate terminal callbacks", async () => {
    const { task, pending } = taskHarness();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("cloudflare-dns.com/dns-query"))
        return Response.json({ Status: 0, Answer: [{ data: "93.184.216.34" }] });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetcher);
    await taskCall(task, "/tasks", "POST", taskBody({ callback_url: "https://example.com/hook" }));
    expect((await taskCall(task, "/tasks/task-1/status", "PUT", null)).status).toBe(400);
    expect((await taskCall(task, "/tasks/task-1/status", "PUT", { status: "done" })).status).toBe(400);
    expect((await taskCall(task, "/tasks/task-1/status", "PUT", { status: "complete", result: "not-json" })).status).toBe(400);
    expect((await taskCall(task, "/tasks/task-1/status", "PUT", { status: "complete", result: JSON.stringify({ text: "x".repeat(530_000) }) })).status).toBe(413);
    expect((await taskCall(task, "/tasks/task-1/status", "PUT", { status: "complete", result: "{}" })).status).toBe(409);
    await taskCall(task, "/tasks/task-1/status", "PUT", { status: "processing" });
    expect((await taskCall(task, "/tasks/task-1/status", "PUT", { status: "complete", result: JSON.stringify({ ok: true }) })).status).toBe(200);
    expect((await taskCall(task, "/tasks/task-1/status", "PUT", { status: "complete", result: JSON.stringify({ ok: true }) })).status).toBe(200);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    const callback = fetcher.mock.calls.find(([input]) => String(input) === "https://example.com/hook");
    expect(callback?.[1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(fetcher.mock.calls.filter(([input]) => String(input) === "https://example.com/hook")).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("bounds and validates long-poll timeout values", async () => {
    const { task } = taskHarness();
    await taskCall(task, "/tasks", "POST", taskBody());
    expect((await taskCall(task, "/tasks/task-1?timeout=31")).status).toBe(400);
    expect((await taskCall(task, "/tasks/task-1?timeout=1.5")).status).toBe(400);
    expect((await taskCall(task, "/tasks/task-1?timeout=-1")).status).toBe(400);
  });
});
