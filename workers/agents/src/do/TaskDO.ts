/**
 * TaskDO — Durable Object for async agent task state.
 *
 * G-AX04: Async agent task with 202 Accepted + status polling.
 *
 * Lifecycle:
 *   queued → processing → complete | failed
 *
 * Task records expire after 24 hours (alarm-based cleanup).
 *
 * WS-7 (audit plan) — DO-naming exception, documented not normalized: this DO is addressed by
 * plain `idFromName(\`tasks:${spaceId}\`)`, not the HMAC-SHA256(tenantId, secret):type:id
 * convention SpaceDO/NaelaoAgentDO use (G-BA01). Accepted because spaceId here is always
 * server-derived from an already-authenticated request (never a raw client-supplied value used
 * directly), so there's no cross-tenant enumeration path THROUGH this worker's own API surface —
 * only a compromised worker with direct DO-binding access could enumerate `tasks:*` names, a
 * different and already-mitigated threat model (workers_dev=false + requireInternalHmac on
 * worker-to-worker calls). Normalizing to the HMAC convention would require a live-migration plan
 * for any already-provisioned TaskDO instances, so it's deferred rather than done speculatively.
 */

import { DurableObject } from "cloudflare:workers";

const TASK_TTL_MS = 24 * 60 * 60 * 1000;
const LONG_POLL_MAX_MS = 30_000;
const LONG_POLL_INTERVAL_MS = 500;

type TaskStatus = "queued" | "processing" | "complete" | "failed";

interface TaskRow {
  id: string;
  space_id: string;
  session_id: string;
  tenant_id: string;
  goal: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  created_at: string;
  expires_at: number;
  callback_url: string | null;
}

export class TaskDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id           TEXT PRIMARY KEY,
        space_id     TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        tenant_id    TEXT NOT NULL,
        goal         TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'queued',
        result       TEXT,
        error        TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at   INTEGER NOT NULL,
        callback_url TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_space ON tasks(space_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_expire ON tasks(expires_at);
    `);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

    // POST /tasks — create a new task
    if (method === "POST" && url.pathname === "/tasks") {
      const body = await request.json<{
        id: string;
        space_id: string;
        session_id: string;
        tenant_id: string;
        goal: string;
        callback_url?: string;
      }>();

      if (!body.id || !body.space_id || !body.tenant_id || !body.goal) {
        return Response.json({ error: "id, space_id, tenant_id, and goal are required" }, { status: 400 });
      }

      const expiresAt = Date.now() + TASK_TTL_MS;
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO tasks (id, space_id, session_id, tenant_id, goal, status, created_at, expires_at, callback_url)
         VALUES (?, ?, ?, ?, ?, 'queued', datetime('now'), ?, ?)`,
        body.id, body.space_id, body.session_id ?? "", body.tenant_id,
        body.goal, expiresAt, body.callback_url ?? null
      );

      // Schedule cleanup alarm
      const existingAlarm = await this.ctx.storage.getAlarm();
      if (!existingAlarm || existingAlarm > expiresAt) {
        await this.ctx.storage.setAlarm(expiresAt);
      }

      return Response.json({ task_id: body.id, status: "queued", expires_at: new Date(expiresAt).toISOString() }, { status: 201 });
    }

    // GET /tasks/:id — poll task status (supports ?timeout=N for long polling)
    const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
    if (method === "GET" && taskMatch?.[1]) {
      const taskId = taskMatch[1];
      const timeoutSec = Math.min(parseInt(url.searchParams.get("timeout") ?? "0", 10), 30);

      if (timeoutSec > 0) {
        // Long poll: check every 500ms until done or timeout
        const deadline = Date.now() + timeoutSec * 1000;
        while (Date.now() < deadline) {
          const task = this.getTask(taskId);
          if (!task) return Response.json({ error: "not_found" }, { status: 404 });
          if (task.status === "complete" || task.status === "failed") {
            return Response.json(this.taskToApi(task));
          }
          // Wait before polling again
          await new Promise<void>((r) => setTimeout(r, LONG_POLL_INTERVAL_MS));
        }
      }

      const task = this.getTask(taskId);
      if (!task) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json(this.taskToApi(task));
    }

    // GET /tasks — list tasks for a space
    if (method === "GET" && url.pathname === "/tasks") {
      const spaceId = url.searchParams.get("space_id");
      if (!spaceId) return Response.json({ error: "space_id required" }, { status: 400 });
      const rows = this.ctx.storage.sql
        .exec(`SELECT * FROM tasks WHERE space_id = ? ORDER BY created_at DESC LIMIT 50`, spaceId)
        .toArray() as unknown as TaskRow[];
      return Response.json({ tasks: rows.map(r => this.taskToApi(r)) });
    }

    // PUT /tasks/:id/status — update task status (internal, called by AgentTaskWorkflow)
    const statusMatch = url.pathname.match(/^\/tasks\/([^/]+)\/status$/);
    if (method === "PUT" && statusMatch?.[1]) {
      const taskId = statusMatch[1];
      const body = await request.json<{ status: TaskStatus; result?: string; error?: string }>();

      const rows = this.ctx.storage.sql
        .exec(`SELECT * FROM tasks WHERE id = ?`, taskId)
        .toArray() as unknown as TaskRow[];
      if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });

      this.ctx.storage.sql.exec(
        `UPDATE tasks SET status = ?, result = ?, error = ? WHERE id = ?`,
        body.status,
        body.result ?? null,
        body.error ?? null,
        taskId
      );

      // Fire callback if provided and task is terminal
      const task = rows[0];
      if (task.callback_url && (body.status === "complete" || body.status === "failed")) {
        this.ctx.waitUntil(this.fireCallback(task.callback_url, taskId, body.status, body.result, body.error));
      }

      return Response.json({ task_id: taskId, status: body.status });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private getTask(id: string): TaskRow | null {
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM tasks WHERE id = ?`, id)
      .toArray() as unknown as TaskRow[];
    return rows[0] ?? null;
  }

  private taskToApi(task: TaskRow): Record<string, unknown> {
    return {
      task_id: task.id,
      space_id: task.space_id,
      session_id: task.session_id,
      status: task.status,
      result: task.result ? JSON.parse(task.result) : null,
      error: task.error,
      created_at: task.created_at,
      expires_at: new Date(task.expires_at).toISOString(),
    };
  }

  private async fireCallback(
    callbackUrl: string,
    taskId: string,
    status: string,
    result?: string,
    error?: string
  ): Promise<void> {
    try {
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: taskId, status, result: result ? JSON.parse(result) : null, error }),
      });
    } catch (err) {
      console.error(`[TaskDO] Callback failed for task ${taskId}: ${err}`);
    }
  }

  override async alarm(): Promise<void> {
    this.ensureInit();
    const nowMs = Date.now();
    this.ctx.storage.sql.exec(
      `DELETE FROM tasks WHERE expires_at <= ?`, nowMs
    );

    // Re-arm if more tasks to expire
    const rows = this.ctx.storage.sql
      .exec(`SELECT MIN(expires_at) as next_exp FROM tasks WHERE expires_at > ?`, nowMs)
      .toArray() as unknown as { next_exp: number | null }[];
    const nextExp = rows[0]?.next_exp;
    if (nextExp) {
      await this.ctx.storage.setAlarm(nextExp);
    }
  }
}
