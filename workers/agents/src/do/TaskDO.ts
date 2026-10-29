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
import { readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";
import { checkSsrf } from "@naelao/security";

const TASK_TTL_MS = 24 * 60 * 60 * 1000;
const LONG_POLL_MAX_MS = 30_000;
const LONG_POLL_INTERVAL_MS = 500;
const MAX_TASK_ID_LENGTH = 128;
const MAX_TASK_TEXT_LENGTH = 32_000;
const MAX_TASK_RESULT_BYTES = 512 * 1024;

function validTaskId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TASK_ID_LENGTH && /^[A-Za-z0-9._:-]+$/.test(value);
}

function parseCallbackUrl(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.toString();
  } catch { return undefined; }
}

function encodeTaskCursor(task: Pick<TaskRow, "created_at" | "id">): string {
  return btoa(JSON.stringify({ created_at: task.created_at, id: task.id })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function parseTaskCursor(value: string | null): { created_at: string; id: string } | null | undefined {
  if (value === null) return null;
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) return undefined;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4));
    const parsed = JSON.parse(binary) as { created_at?: unknown; id?: unknown };
    if (typeof parsed.created_at !== "string" || parsed.created_at.length > 40 || !validTaskId(parsed.id)) return undefined;
    return { created_at: parsed.created_at, id: parsed.id };
  } catch { return undefined; }
}

/** `awaiting_approval` is a real, non-terminal state, not a flavour of complete: the run stopped
 *  at a human-in-the-loop gate with its work intact and will continue once someone answers.
 *  Treating it as terminal would fire the completion callback for something that hasn't
 *  happened, and tell the caller their task finished. */
type TaskStatus = "queued" | "processing" | "awaiting_approval" | "complete" | "failed";

interface TaskRow {
  id: string;
  space_id: string;
  session_id: string;
  project_id: string | null;
  tenant_id: string;
  goal: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  created_at: string;
  created_at_ms: number | null;
  finished_at_ms: number | null;
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
        project_id   TEXT,
        tenant_id    TEXT NOT NULL,
        goal         TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'queued',
        result       TEXT,
        error        TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        created_at_ms INTEGER,
        finished_at_ms INTEGER,
        expires_at   INTEGER NOT NULL,
        callback_url TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_expire ON tasks(expires_at);
    `);
    const columns = this.ctx.storage.sql.exec("PRAGMA table_info(tasks)").toArray() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "project_id")) this.ctx.storage.sql.exec("ALTER TABLE tasks ADD COLUMN project_id TEXT");
    if (!columns.some(column => column.name === "created_at_ms")) this.ctx.storage.sql.exec("ALTER TABLE tasks ADD COLUMN created_at_ms INTEGER");
    if (!columns.some(column => column.name === "finished_at_ms")) this.ctx.storage.sql.exec("ALTER TABLE tasks ADD COLUMN finished_at_ms INTEGER");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_tasks_space ON tasks(space_id, created_at DESC)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(space_id, project_id, created_at DESC)");
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      try {
        request = new Request(request, { body: await readBoundedRequestBytes(request, 1024 * 1024) });
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
        return Response.json({ error_code: "invalid_request_body" }, { status: 400 });
      }
    }
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

    // POST /tasks — create a new task
    if (method === "POST" && url.pathname === "/tasks") {
      const value: unknown = await request.json().catch(() => undefined);
      if (!value || typeof value !== "object" || Array.isArray(value))
        return Response.json({ error: "invalid_request" }, { status: 400 });
      const body = value as Record<string, unknown>;
      const callbackUrl = parseCallbackUrl(body.callback_url);
      if (!validTaskId(body.id) || typeof body.space_id !== "string" || !body.space_id.trim() || body.space_id.length > 256 ||
          typeof body.tenant_id !== "string" || !body.tenant_id.trim() || body.tenant_id.length > 256 ||
          typeof body.session_id !== "string" || !body.session_id.trim() || body.session_id.length > 512 ||
          (body.project_id !== undefined && body.project_id !== null && (typeof body.project_id !== "string" || !body.project_id.trim() || body.project_id.length > 256)) ||
          typeof body.goal !== "string" || !body.goal.trim() || body.goal.length > MAX_TASK_TEXT_LENGTH ||
          callbackUrl === undefined) {
        return Response.json({ error: "id, space_id, tenant_id, and goal are required" }, { status: 400 });
      }
      if (callbackUrl) {
        const destination = await checkSsrf(callbackUrl);
        if (destination.blocked) return Response.json({ error: "callback_destination_blocked" }, { status: 400 });
      }

      const existing = this.ctx.storage.sql.exec(`SELECT * FROM tasks WHERE id = ?`, body.id).toArray() as unknown as TaskRow[];
      if (existing[0]) return Response.json({ error: "task_id_conflict" }, { status: 409 });

      const expiresAt = Date.now() + TASK_TTL_MS;
      this.ctx.storage.sql.exec(
        `INSERT INTO tasks (id, space_id, session_id, project_id, tenant_id, goal, status, created_at, created_at_ms, expires_at, callback_url)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', datetime('now'), ?, ?, ?)`,
        body.id, body.space_id, body.session_id, body.project_id ?? null, body.tenant_id,
        body.goal, Date.now(), expiresAt, callbackUrl
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
      const timeoutText = url.searchParams.get("timeout") ?? "0";
      if (!/^(0|[1-9][0-9]?)$/.test(timeoutText) || Number(timeoutText) > LONG_POLL_MAX_MS / 1000)
        return Response.json({ error: "invalid_timeout" }, { status: 400 });
      const timeoutSec = Number(timeoutText);

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
      const sessionId = url.searchParams.get("session_id");
      const projectId = url.searchParams.get("project_id");
      const cursor = parseTaskCursor(url.searchParams.get("cursor"));
      if (!spaceId) return Response.json({ error: "space_id required" }, { status: 400 });
      if (spaceId.length > 256) return Response.json({ error: "invalid_space_id" }, { status: 400 });
      if (sessionId !== null && (!sessionId.trim() || sessionId.length > 512)) return Response.json({ error: "invalid_session_id" }, { status: 400 });
      if (projectId !== null && (!projectId.trim() || projectId.length > 256)) return Response.json({ error: "invalid_project_id" }, { status: 400 });
      if (cursor === undefined) return Response.json({ error: "invalid_cursor" }, { status: 400 });
      const filters = ["space_id = ?", "expires_at > ?"];
      const values: Array<string | number> = [spaceId, Date.now()];
      if (sessionId) { filters.push("session_id = ?"); values.push(sessionId); }
      if (projectId) { filters.push("project_id = ?"); values.push(projectId); }
      if (cursor) { filters.push("(created_at < ? OR (created_at = ? AND id < ?))"); values.push(cursor.created_at, cursor.created_at, cursor.id); }
      const rows = this.ctx.storage.sql
        .exec(`SELECT * FROM tasks WHERE ${filters.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT 51`, ...values)
        .toArray() as unknown as TaskRow[];
      const hasMore = rows.length > 50;
      const page = rows.slice(0, 50);
      return Response.json({ tasks: page.map(r => this.taskToApi(r)), has_more: hasMore,
        next_cursor: hasMore && page.length ? encodeTaskCursor(page[page.length - 1]!) : null });
    }

    // PUT /tasks/:id/status — update task status (internal, called by AgentTaskWorkflow)
    const statusMatch = url.pathname.match(/^\/tasks\/([^/]+)\/status$/);
    if (method === "PUT" && statusMatch?.[1]) {
      const taskId = statusMatch[1];
      const value: unknown = await request.json().catch(() => undefined);
      if (!value || typeof value !== "object" || Array.isArray(value))
        return Response.json({ error: "invalid_request" }, { status: 400 });
      const body = value as { status?: unknown; result?: unknown; error?: unknown };
      if (!(["processing", "awaiting_approval", "complete", "failed"] as unknown[]).includes(body.status) ||
          (body.result !== undefined && body.result !== null && typeof body.result !== "string") ||
          (body.error !== undefined && body.error !== null && (typeof body.error !== "string" || body.error.length > 4000)))
        return Response.json({ error: "invalid_task_status" }, { status: 400 });
      if (typeof body.result === "string") {
        if (new TextEncoder().encode(body.result).byteLength > MAX_TASK_RESULT_BYTES)
          return Response.json({ error: "task_result_too_large" }, { status: 413 });
        try { JSON.parse(body.result); }
        catch { return Response.json({ error: "task_result_invalid_json" }, { status: 400 }); }
      }

      const rows = this.ctx.storage.sql
        .exec(`SELECT * FROM tasks WHERE id = ?`, taskId)
        .toArray() as unknown as TaskRow[];
      if (!rows[0] || rows[0].expires_at <= Date.now()) return Response.json({ error: "not_found" }, { status: 404 });
      const status = body.status as TaskStatus;
      const current = rows[0].status;
      const allowed: Record<TaskStatus, readonly TaskStatus[]> = {
        queued: ["processing", "failed"],
        processing: ["awaiting_approval", "complete", "failed"],
        awaiting_approval: ["processing", "complete", "failed"],
        complete: [],
        failed: [],
      };
      if (current === status) return Response.json({ task_id: taskId, status, idempotent: true });
      if (!allowed[current]?.includes(status))
        return Response.json({ error: "invalid_task_transition", current_status: current }, { status: 409 });

      this.ctx.storage.sql.exec(
        `UPDATE tasks SET status = ?, result = ?, error = ?, finished_at_ms = ? WHERE id = ?`,
        status,
        body.result ?? null,
        body.error ?? null,
        status === "complete" || status === "failed" ? Date.now() : null,
        taskId
      );

      // Fire callback if provided and task is terminal
      const task = rows[0];
      if (task.callback_url && (status === "complete" || status === "failed")) {
        this.ctx.waitUntil(this.fireCallback(task.callback_url, taskId, status, body.result as string | undefined, body.error as string | undefined));
      }

      return Response.json({ task_id: taskId, status });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private getTask(id: string): TaskRow | null {
    if (!validTaskId(id)) return null;
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM tasks WHERE id = ?`, id)
      .toArray() as unknown as TaskRow[];
    if (rows[0] && rows[0].expires_at <= Date.now()) {
      this.ctx.storage.sql.exec(`DELETE FROM tasks WHERE id = ? AND expires_at <= ?`, id, Date.now());
      return null;
    }
    return rows[0] ?? null;
  }

  private taskToApi(task: TaskRow): Record<string, unknown> {
    const elapsedEnd = task.finished_at_ms ?? Date.now();
    const elapsedMs = typeof task.created_at_ms === "number" && Number.isSafeInteger(task.created_at_ms) && elapsedEnd >= task.created_at_ms
      ? elapsedEnd - task.created_at_ms
      : undefined;
    return {
      task_id: task.id,
      space_id: task.space_id,
      session_id: task.session_id,
      project_id: task.project_id ?? null,
      status: task.status,
      result: task.result ? JSON.parse(task.result) : null,
      error: task.error,
      created_at: task.created_at,
      ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs } : {}),
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
      const parsed = parseCallbackUrl(callbackUrl);
      if (!parsed) throw new Error("callback_destination_invalid");
      const destination = await checkSsrf(parsed);
      if (destination.blocked) throw new Error("callback_destination_blocked");
      const response = await fetch(parsed, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: taskId, status, result: result ? JSON.parse(result) : null, error }),
      });
      await response.body?.cancel().catch(() => undefined);
    } catch (err) {
      console.error(`[TaskDO] Callback failed for task ${taskId}: ${err instanceof Error ? err.message : "unknown_error"}`);
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
