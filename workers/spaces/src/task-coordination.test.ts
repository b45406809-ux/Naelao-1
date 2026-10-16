import { describe, expect, it } from "vitest";
import { SpaceDO } from "./do/SpaceDO.js";

type Row = Record<string, unknown>;

function makeSpaceDO(rows: Row[] = []) {
  const taskRows = new Map(rows.map((row) => [String(row.id), { ...row }]));
  const projects = new Map<string, Row>();
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const lower = query.toLowerCase();
      if (lower.includes("select p.execution_status")) {
        const task = taskRows.get(String(args[0]));
        return { toArray: () => task ? [{ execution_status: task.execution_status ?? "ACTIVE" }] : [] };
      }
      if (lower.includes("update tasks set claimed_by")) {
        const id = String(args[3]);
        const assistant = String(args[0]);
        const task = taskRows.get(id);
        if (!task || (task.claimed_by && task.claimed_by !== assistant && task.lease_expires_at > String(args[5]))) return { toArray: () => [] };
        task.claimed_by = assistant;
        task.lease_expires_at = args[1];
        task.status = "in_progress";
        return { toArray: () => [{ claimed_by: assistant, lease_expires_at: args[1] }] };
      }
      if (lower.includes("select claimed_by, lease_expires_at, spectator_assistant_ids")) {
        const task = taskRows.get(String(args[0]));
        return { toArray: () => task ? [task] : [] };
      }
      if (lower.includes("select id, thread_id, intent_embedding, prompt_text")) {
        return { toArray: () => [...taskRows.values()].filter((task) => ["pending", "in_progress", "blocked"].includes(String(task.status))) };
      }
      if (lower.includes("select id, space_id from projects")) {
        const project = projects.get(String(args[0]));
        return { toArray: () => project ? [project] : [] };
      }
      if (lower.includes("select lifecycle, status, name from projects")) return { toArray: () => [] };
      if (lower.includes("from tasks where id")) {
        const task = taskRows.get(String(args[0]));
        return { toArray: () => task ? [task] : [] };
      }
      if (lower.startsWith("insert into tasks")) {
        const [id, space_id, project_id, thread_id, title, status, dependencies, assigned_agent, subtask_spec, assigned_role, model, file_paths, budget_tokens, prompt_text, intent_embedding, created_at, updated_at] = args;
        taskRows.set(String(id), { id, space_id, project_id, thread_id, title, status, dependencies, assigned_agent, subtask_spec, assigned_role, model, file_paths, budget_tokens, prompt_text, intent_embedding, created_at, updated_at });
        return { rowsWritten: 1, toArray: () => [] };
      }
      return { rowsWritten: 1, toArray: () => [] };
    },
  };
  const ctx = {
    storage: {
      sql,
      transactionSync: (fn: () => unknown) => fn(),
      deleteAlarm: async () => undefined,
      setAlarm: async (_at: number) => undefined,
    },
  };
  const instance = new SpaceDO(ctx as never, { PLATFORM_SECRET: "secret" } as never);
  return { instance, taskRows, projects };
}

describe("SpaceDO task coordination journey", () => {
  it("gives one worker a 15-minute lease and turns the loser into a spectator", async () => {
    const h = makeSpaceDO([{ id: "task-1", status: "pending", claimed_by: null, lease_expires_at: null, spectator_assistant_ids: "[]" }]);
    const claim = await h.instance.fetch(new Request("https://space/tasks/task-1/lease", { method: "POST", body: JSON.stringify({ assistantId: "worker-a" }) }));
    expect(claim.status).toBe(200);
    const claimBody = await claim.json() as { status: string; leaseExpiresAt: string };
    expect(claimBody.status).toBe("CLAIMED");
    expect(Date.parse(claimBody.leaseExpiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(Date.parse(claimBody.leaseExpiresAt) - Date.now()).toBeLessThan(16 * 60_000);
    const spectator = await h.instance.fetch(new Request("https://space/tasks/task-1/lease", { method: "POST", body: JSON.stringify({ assistantId: "worker-b" }) }));
    expect((await spectator.json() as { status: string; suggestedAction: string })).toMatchObject({ status: "SPECTATING", suggestedAction: "AUDIT_ACTIVE_PULL_REQUEST" });
  });

  it("detects an active semantic duplicate above the 0.85 threshold", async () => {
    const h = makeSpaceDO([{ id: "task-1", status: "in_progress", thread_id: "thread-1", prompt_text: "prepare the quarterly revenue report", intent_embedding: null }]);
    const response = await h.instance.fetch(new Request("https://space/intent-deduplicate", { method: "POST", body: JSON.stringify({ projectId: "project-1", promptText: "prepare the quarterly revenue report" }) }));
    expect(await response.json()).toMatchObject({ duplicate: true, existingTaskId: "task-1", threadId: "thread-1" });
  });

  it("keeps the durable orchestration task board separate from worker runtime selection", async () => {
    const h = makeSpaceDO();
    const createTask = (body: Record<string, unknown>) => (h.instance as unknown as { createTask(request: Request): Promise<Response> }).createTask(
      new Request("https://space/tasks", { method: "POST", body: JSON.stringify({ id: "goal:media", space_id: "space-1", title: "Transcode", ...body }) }),
    );
    const created = await createTask({ dependencies: [] });
    expect(created.status).toBe(201);
    expect(await (await createTask({ dependencies: [] })).json()).toMatchObject({ replayed: true });
    expect((await createTask({ dependencies: [], container_capabilities: ["video.transcode"] })).status).toBe(200);
  });

  it("freezes a project and records an RFC for conflicting sponsors", async () => {
    const h = makeSpaceDO();
    h.projects.set("project-1", { id: "project-1", space_id: "space-1" });
    const response = await h.instance.fetch(new Request("https://space/rfcs", { method: "POST", body: JSON.stringify({ projectId: "project-1", conflictingDirectives: [{ sponsorId: "a", directive: "ship" }, { sponsorId: "b", directive: "wait" }] }) }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ projectId: "project-1", status: "OPEN", executionStatus: "FROZEN_FOR_RFC" });
  });
});
