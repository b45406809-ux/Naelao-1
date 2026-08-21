/**
 * tasks (AVOS plan step 4) — a per-project task DAG for multi-agent coordination, distinct from
 * project_journal's own todos (project-journal.ts): a journal todo is a loose personal checklist
 * item (text + done, no dependency graph, no assignment) — fine for "what I still need to do,"
 * useless for "my task is blocked on a DIFFERENT agent finishing theirs." A task here can declare
 * `dependencies` (other task ids) and an `assigned_agent`, and task.start refuses to move a task
 * to in_progress until every dependency is actually completed — the DAG's edges are enforced
 * HERE, in this prebuilt, not trusted to the model's own bookkeeping (the same "structure over
 * prompts" reasoning as every other hard gate in this engine).
 *
 * Storage is SpaceDO's own `tasks` table (dumb CRUD; see SpaceDO.ts's own header on that split).
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";

interface TaskRow {
  id: string;
  space_id: string;
  project_id: string | null;
  thread_id: string | null;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
  dependencies: string[];
  assigned_agent: string | null;
  created_at: string;
  updated_at: string;
}

async function spacesCall(
  ctx: PrebuiltOpContext,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; status: number; json: unknown }> {
  if (!ctx.env.spacesWorker) throw new Error("tasks unavailable: spaces worker binding not configured");
  const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
  const resp = await ctx.env.spacesWorker.fetch(
    new Request(`http://spaces-worker${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": token,
        // Act on behalf of the person who asked, when there is one — same reasoning as
        // schedule.ts/project-coordination.ts's own spacesCall: correct attribution, and the
        // assistant is clamped to what that person could do unaided.
        ...(ctx.env.userId ? { "x-naelao-user-id": ctx.env.userId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
  const json = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, json };
}

async function listRaw(ctx: PrebuiltOpContext, filters: Record<string, string> = {}): Promise<TaskRow[]> {
  const qs = new URLSearchParams({ ...(ctx.env.projectId ? { project_id: ctx.env.projectId } : {}), ...filters });
  const res = await spacesCall(ctx, "GET", `/spaces/${ctx.env.spaceId}/tasks?${qs.toString()}`);
  if (!res.ok) return [];
  return ((res.json as { data?: TaskRow[] }).data ?? []) as TaskRow[];
}

function reqId(a: Record<string, unknown>): string {
  const id = String(a["id"] ?? "").trim();
  if (!id) throw new Error("'id' (a task id from task.list) is required");
  return id;
}

async function setStatus(ctx: PrebuiltOpContext, id: string, status: TaskRow["status"]): Promise<unknown> {
  const res = await spacesCall(ctx, "PATCH", `/spaces/${ctx.env.spaceId}/tasks/${encodeURIComponent(id)}`, { status });
  if (!res.ok) return { ok: false, error: `failed to update task ${id}: HTTP ${res.status}` };
  return { ok: true, task: res.json };
}

export const tasks: PrebuiltScript = {
  name: "tasks",
  description:
    "A task DAG for coordinating work ACROSS agents in this project — declare a task, say what " +
    "it depends on and who owns it, and task.start refuses to begin it until its dependencies " +
    "are actually completed. Use project_journal for your own running notes; use this when " +
    "another agent's work genuinely depends on knowing this one is done.",
  domain: "orchestration",
  requires_tier: 1,
  paramHints: {
    "task.create": "title (string, REQUIRED). dependencies (string[], optional — other task ids " +
      "this one can't start until they're completed). assigned_agent (string, optional — an " +
      "agent id from thread.list_project_agents). thread_id (string, optional).",
    "task.start": "id (string, REQUIRED — from task.list). Refused (status stays 'pending') if any " +
      "dependency isn't completed yet.",
    "task.complete": "id (string, REQUIRED).",
    "task.block": "id (string, REQUIRED).",
    "task.list": "status (string, optional — pending/in_progress/completed/blocked/cancelled). " +
      "thread_id (string, optional). Omit both to list every task in this project.",
  },
  operations: {
    async "task.create"(a, c) {
      const title = String(a["title"] ?? "").trim();
      if (!title) throw new Error("task.create requires 'title'");
      const dependencies = Array.isArray(a["dependencies"]) ? (a["dependencies"] as unknown[]).map(String) : [];
      const res = await spacesCall(c, "POST", `/spaces/${c.env.spaceId}/tasks`, {
        title,
        ...(c.env.projectId ? { project_id: c.env.projectId } : {}),
        ...(typeof a["thread_id"] === "string" ? { thread_id: a["thread_id"] } : {}),
        ...(dependencies.length ? { dependencies } : {}),
        ...(typeof a["assigned_agent"] === "string" ? { assigned_agent: a["assigned_agent"] } : {}),
      });
      if (!res.ok) return { ok: false, error: `failed to create task: HTTP ${res.status}` };
      return { ok: true, task: res.json };
    },

    async "task.start"(a, c) {
      const id = reqId(a);
      const all = await listRaw(c);
      const target = all.find((t) => t.id === id);
      if (!target) return { ok: false, error: `task ${id} not found in this project` };
      const unmet = target.dependencies.filter((depId) => {
        const dep = all.find((t) => t.id === depId);
        return !dep || dep.status !== "completed";
      });
      if (unmet.length > 0) {
        return {
          ok: false,
          error: `task ${id} has unfinished dependencies: ${unmet.join(", ")}. It stays pending until those are completed.`,
          blocked_on: unmet,
        };
      }
      return setStatus(c, id, "in_progress");
    },

    async "task.complete"(a, c) {
      return setStatus(c, reqId(a), "completed");
    },

    async "task.block"(a, c) {
      return setStatus(c, reqId(a), "blocked");
    },

    async "task.list"(a, c) {
      const filters: Record<string, string> = {};
      if (typeof a["status"] === "string" && a["status"]) filters.status = a["status"] as string;
      if (typeof a["thread_id"] === "string" && a["thread_id"]) filters.thread_id = a["thread_id"] as string;
      const rows = await listRaw(c, filters);
      return { tasks: rows, count: rows.length };
    },
  },
};
