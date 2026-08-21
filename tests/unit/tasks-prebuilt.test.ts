import { describe, it, expect } from "vitest";
import { tasks } from "../../workers/agents/src/script-engine/prebuilt/tasks.js";
import { isReadSafeOperation } from "../../workers/agents/src/script-engine/assistant-access.js";
import { LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED, DEFAULT_NAELAO_AGENT, LAUNCHPAD_ASSISTANT_PROFILE } from "../../workers/agents/src/script-engine/profiles.js";
import type { PrebuiltOpContext } from "../../workers/agents/src/script-engine/prebuilt/index.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// AVOS plan, step 4 — the `tasks` prebuilt: create/list/complete/block, and the load-bearing
// piece, task.start's dependency gate (enforced HERE, not trusted to the model — same
// "structure over prompts" reasoning as every other hard gate in this engine).

interface FakeTaskRow {
  id: string;
  space_id: string;
  project_id: string | null;
  title: string;
  status: string;
  dependencies: string[];
  assigned_agent: string | null;
}

/** A tiny in-memory stand-in for the real SpaceDO /tasks routes (spacedo-tasks.test.ts already
 *  covers the real store end to end) — this fixture only needs to mirror its OBSERVABLE
 *  contract (create/list/patch shapes) so tasks.ts's own logic is what's under test here. */
function makeTasksSpacesWorker(seed: FakeTaskRow[] = []): { fetcher: Fetcher; store: FakeTaskRow[] } {
  const store = [...seed];
  let n = 0;
  const fetcher: Fetcher = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.endsWith("/tasks")) {
        const projectId = url.searchParams.get("project_id");
        const status = url.searchParams.get("status");
        let rows = store;
        if (projectId) rows = rows.filter((r) => r.project_id === projectId);
        if (status) rows = rows.filter((r) => r.status === status);
        return Response.json({ data: rows, count: rows.length });
      }
      if (req.method === "POST" && url.pathname.endsWith("/tasks")) {
        const body = (await req.clone().json()) as Partial<FakeTaskRow>;
        const row: FakeTaskRow = {
          id: `task-${++n}`,
          space_id: body.space_id ?? "space-1",
          project_id: body.project_id ?? null,
          title: body.title ?? "",
          status: "pending",
          dependencies: body.dependencies ?? [],
          assigned_agent: body.assigned_agent ?? null,
        };
        store.push(row);
        return Response.json(row, { status: 201 });
      }
      const patchMatch = url.pathname.match(/\/tasks\/([^/]+)$/);
      if (req.method === "PATCH" && patchMatch) {
        const row = store.find((r) => r.id === patchMatch[1]);
        if (!row) return Response.json({ error_code: "not_found" }, { status: 404 });
        const body = (await req.clone().json()) as Partial<FakeTaskRow>;
        Object.assign(row, body);
        return Response.json(row);
      }
      return Response.json({ error_code: "not_found" }, { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, store };
}

function makeCtx(fetcher: Fetcher, projectId?: string): PrebuiltOpContext {
  const env = {
    spaceId: "space-1", agentId: "agent-1", tenantId: "tenant-1",
    platformSecret: "secret", spacesWorker: fetcher, ...(projectId ? { projectId } : {}),
  } as unknown as ScriptEngineEnv;
  return { env, run: async () => ({}) };
}

describe("tasks.create", () => {
  it("creates a task scoped to the run's project", async () => {
    const { fetcher, store } = makeTasksSpacesWorker();
    const ctx = makeCtx(fetcher, "proj-1");
    const res = (await tasks.operations["task.create"]!({ title: "Ship it" }, ctx)) as { ok: boolean; task: FakeTaskRow };
    expect(res.ok).toBe(true);
    expect(res.task.title).toBe("Ship it");
    expect(store[0]!.project_id).toBe("proj-1");
  });

  it("requires a title", async () => {
    const { fetcher } = makeTasksSpacesWorker();
    await expect(tasks.operations["task.create"]!({}, makeCtx(fetcher))).rejects.toThrow(/title/);
  });

  it("passes dependencies and assigned_agent through", async () => {
    const { fetcher, store } = makeTasksSpacesWorker();
    await tasks.operations["task.create"]!({ title: "Deploy", dependencies: ["task-1"], assigned_agent: "dev-agent" }, makeCtx(fetcher));
    expect(store[0]!.dependencies).toEqual(["task-1"]);
    expect(store[0]!.assigned_agent).toBe("dev-agent");
  });
});

describe("tasks.list", () => {
  it("lists everything in the run's project by default", async () => {
    const { fetcher } = makeTasksSpacesWorker([
      { id: "t1", space_id: "space-1", project_id: "proj-1", title: "A", status: "pending", dependencies: [], assigned_agent: null },
      { id: "t2", space_id: "space-1", project_id: "proj-2", title: "B", status: "pending", dependencies: [], assigned_agent: null },
    ]);
    const res = (await tasks.operations["task.list"]!({}, makeCtx(fetcher, "proj-1"))) as { tasks: FakeTaskRow[]; count: number };
    expect(res.count).toBe(1);
    expect(res.tasks[0]!.id).toBe("t1");
  });

  it("filters by status when asked", async () => {
    const { fetcher } = makeTasksSpacesWorker([
      { id: "t1", space_id: "space-1", project_id: "proj-1", title: "A", status: "completed", dependencies: [], assigned_agent: null },
      { id: "t2", space_id: "space-1", project_id: "proj-1", title: "B", status: "pending", dependencies: [], assigned_agent: null },
    ]);
    const res = (await tasks.operations["task.list"]!({ status: "completed" }, makeCtx(fetcher, "proj-1"))) as { count: number };
    expect(res.count).toBe(1);
  });
});

describe("tasks.start — the dependency gate (the load-bearing part of this whole prebuilt)", () => {
  it("refuses to start a task whose dependency isn't completed yet", async () => {
    const { fetcher } = makeTasksSpacesWorker([
      { id: "dep-1", space_id: "space-1", project_id: "proj-1", title: "Design", status: "in_progress", dependencies: [], assigned_agent: null },
      { id: "main-1", space_id: "space-1", project_id: "proj-1", title: "Build", status: "pending", dependencies: ["dep-1"], assigned_agent: null },
    ]);
    const res = (await tasks.operations["task.start"]!({ id: "main-1" }, makeCtx(fetcher, "proj-1"))) as {
      ok: boolean; blocked_on: string[];
    };
    expect(res.ok).toBe(false);
    expect(res.blocked_on).toEqual(["dep-1"]);
  });

  it("refuses when the dependency id doesn't even exist — fails closed, not silently permissive", async () => {
    const { fetcher } = makeTasksSpacesWorker([
      { id: "main-1", space_id: "space-1", project_id: "proj-1", title: "Build", status: "pending", dependencies: ["ghost-task"], assigned_agent: null },
    ]);
    const res = (await tasks.operations["task.start"]!({ id: "main-1" }, makeCtx(fetcher, "proj-1"))) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it("starts the task once ALL dependencies are completed", async () => {
    const { fetcher, store } = makeTasksSpacesWorker([
      { id: "dep-1", space_id: "space-1", project_id: "proj-1", title: "Design", status: "completed", dependencies: [], assigned_agent: null },
      { id: "dep-2", space_id: "space-1", project_id: "proj-1", title: "Review", status: "completed", dependencies: [], assigned_agent: null },
      { id: "main-1", space_id: "space-1", project_id: "proj-1", title: "Build", status: "pending", dependencies: ["dep-1", "dep-2"], assigned_agent: null },
    ]);
    const res = (await tasks.operations["task.start"]!({ id: "main-1" }, makeCtx(fetcher, "proj-1"))) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(store.find((r) => r.id === "main-1")!.status).toBe("in_progress");
  });

  it("a task with no dependencies starts immediately", async () => {
    const { fetcher, store } = makeTasksSpacesWorker([
      { id: "solo-1", space_id: "space-1", project_id: "proj-1", title: "Standalone", status: "pending", dependencies: [], assigned_agent: null },
    ]);
    const res = (await tasks.operations["task.start"]!({ id: "solo-1" }, makeCtx(fetcher, "proj-1"))) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(store[0]!.status).toBe("in_progress");
  });

  it("reports an error (not a throw) for an unknown task id", async () => {
    const { fetcher } = makeTasksSpacesWorker([]);
    const res = (await tasks.operations["task.start"]!({ id: "nope" }, makeCtx(fetcher, "proj-1"))) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });

  it("requires an id", async () => {
    const { fetcher } = makeTasksSpacesWorker([]);
    await expect(tasks.operations["task.start"]!({}, makeCtx(fetcher))).rejects.toThrow(/id/);
  });
});

describe("gating — task.list is read-safe/auto-approved; the writes stay gated", () => {
  it("task.list is read-safe under the F-36 viewer clamp", () => {
    expect(isReadSafeOperation("task.list")).toBe(true);
    expect(isReadSafeOperation("task.create")).toBe(false);
    expect(isReadSafeOperation("task.start")).toBe(false);
    expect(isReadSafeOperation("task.complete")).toBe(false);
  });

  it("task.list is in the guided-mode default auto-approved list; the writes are not", () => {
    expect(LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED).toContain("task.list");
    expect(LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED).not.toContain("task.create");
    expect(LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED).not.toContain("task.start");
  });

  it("both assistant profiles enable the tasks script", () => {
    expect(DEFAULT_NAELAO_AGENT.config.scripts.prebuilt).toContain("tasks");
    expect(LAUNCHPAD_ASSISTANT_PROFILE.config.scripts.prebuilt).toContain("tasks");
  });
});

describe("tasks.complete / tasks.block", () => {
  it("complete sets status to completed", async () => {
    const { fetcher, store } = makeTasksSpacesWorker([
      { id: "t1", space_id: "space-1", project_id: "proj-1", title: "A", status: "in_progress", dependencies: [], assigned_agent: null },
    ]);
    const res = (await tasks.operations["task.complete"]!({ id: "t1" }, makeCtx(fetcher, "proj-1"))) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(store[0]!.status).toBe("completed");
  });

  it("block sets status to blocked", async () => {
    const { fetcher, store } = makeTasksSpacesWorker([
      { id: "t1", space_id: "space-1", project_id: "proj-1", title: "A", status: "in_progress", dependencies: [], assigned_agent: null },
    ]);
    const res = (await tasks.operations["task.block"]!({ id: "t1" }, makeCtx(fetcher, "proj-1"))) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(store[0]!.status).toBe("blocked");
  });
});
