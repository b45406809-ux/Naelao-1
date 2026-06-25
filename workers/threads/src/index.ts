// G-T01..G-T08: Threads — multi-session conversation threading with LLM-generated summaries
import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  LLM_GATEWAY_URL: string;
}

interface Thread {
  id: string;
  space_id: string;
  tenant_id: string;
  end_user_id: string;
  title: string | null;
  summary: string | null;
  session_count: number;
  last_active_at: string;
  created_at: string;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
  if (!env.LLM_GATEWAY_URL) throw new Error("Missing required var: LLM_GATEWAY_URL");
}

function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }) {
  return {
    tenantId: c.req.header("x-naelao-tenant-id") ?? "",
    userId: c.req.header("x-naelao-user-id") ?? "",
  };
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// List threads for a space+user
app.get("/v1/threads", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const url = new URL(c.req.url);
  const spaceId = url.searchParams.get("space_id");
  const endUserId = url.searchParams.get("end_user_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const conditions: string[] = ["tenant_id = ?"];
  const params: unknown[] = [tenantId];
  if (spaceId) { conditions.push("space_id = ?"); params.push(spaceId); }
  if (endUserId) { conditions.push("end_user_id = ?"); params.push(endUserId); }
  params.push(limit, offset);

  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT id, space_id, tenant_id, end_user_id, title, summary, session_count, last_active_at, created_at
     FROM threads WHERE ${conditions.join(" AND ")} ORDER BY last_active_at DESC LIMIT ? OFFSET ?`
  ).bind(...params).all<Thread>();
  return c.json({ data: results });
});

// Get single thread with its sessions
app.get("/v1/threads/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const thread = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM threads WHERE id = ? AND tenant_id = ?"
  ).bind(c.req.param("id"), tenantId).first<Thread>();
  if (!thread) return c.json({ error_code: "not_found", message: "Thread not found" }, 404);

  const { results: sessions } = await c.env.PLATFORM_DB.prepare(
    "SELECT id, status, created_at, ended_at FROM sessions WHERE thread_id = ? AND tenant_id = ? ORDER BY created_at ASC"
  ).bind(thread.id, tenantId).all();
  return c.json({ data: { ...thread, sessions } });
});

// Create thread
app.post("/v1/threads", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json<{ space_id: string; end_user_id: string; title?: string }>();
  if (!body.space_id || !body.end_user_id) {
    return c.json({ error_code: "bad_request", message: "space_id and end_user_id required" }, 400);
  }
  // Verify space belongs to tenant
  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM spaces WHERE id = ? AND tenant_id = ?"
  ).bind(body.space_id, tenantId).first<{ id: string }>();
  if (!space) return c.json({ error_code: "not_found", message: "Space not found" }, 404);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO threads (id, space_id, tenant_id, end_user_id, title, summary, session_count, last_active_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`
  ).bind(id, body.space_id, tenantId, body.end_user_id, body.title ?? null, now, now, now).run();
  return c.json({ id, space_id: body.space_id, end_user_id: body.end_user_id, title: body.title ?? null, session_count: 0, created_at: now }, 201);
});

// Attach a session to a thread (called after session creation)
app.post("/v1/threads/:id/sessions", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const thread = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM threads WHERE id = ? AND tenant_id = ?"
  ).bind(c.req.param("id"), tenantId).first<{ id: string }>();
  if (!thread) return c.json({ error_code: "not_found", message: "Thread not found" }, 404);

  const body = await c.req.json<{ session_id: string }>();
  if (!body.session_id) return c.json({ error_code: "bad_request", message: "session_id required" }, 400);

  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    "UPDATE sessions SET thread_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(thread.id, now, body.session_id, tenantId).run();
  await c.env.PLATFORM_DB.prepare(
    "UPDATE threads SET session_count = session_count + 1, last_active_at = ?, updated_at = ? WHERE id = ?"
  ).bind(now, now, thread.id).run();
  return c.json({ thread_id: thread.id, session_id: body.session_id });
});

// Generate/refresh thread summary using LLM
app.post("/v1/threads/:id/summarize", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const thread = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM threads WHERE id = ? AND tenant_id = ?"
  ).bind(c.req.param("id"), tenantId).first<{ id: string }>();
  if (!thread) return c.json({ error_code: "not_found", message: "Thread not found" }, 404);

  // Fetch last 50 messages across all sessions in this thread
  const { results: messages } = await c.env.PLATFORM_DB.prepare(
    `SELECT m.role, m.content FROM messages m
     JOIN sessions s ON m.session_id = s.id
     WHERE s.thread_id = ? AND s.tenant_id = ?
     ORDER BY m.created_at DESC LIMIT 50`
  ).bind(thread.id, tenantId).all<{ role: string; content: string }>();

  if (messages.length === 0) return c.json({ summary: null });

  const transcript = messages
    .reverse()
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  // LLM call to generate summary
  const summary = await generateSummary(transcript, c.env);
  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    "UPDATE threads SET summary = ?, updated_at = ? WHERE id = ?"
  ).bind(summary, now, thread.id).run();
  return c.json({ summary, updated_at: now });
});

// Delete thread and detach sessions
app.delete("/v1/threads/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  // Detach sessions
  await c.env.PLATFORM_DB.prepare(
    "UPDATE sessions SET thread_id = NULL WHERE thread_id = ? AND tenant_id = ?"
  ).bind(c.req.param("id"), tenantId).run();
  const result = await c.env.PLATFORM_DB.prepare(
    "DELETE FROM threads WHERE id = ? AND tenant_id = ?"
  ).bind(c.req.param("id"), tenantId).run();
  if (result.meta.changes === 0) return c.json({ error_code: "not_found", message: "Thread not found" }, 404);
  return c.json({ deleted: true });
});

async function generateSummary(transcript: string, env: Env): Promise<string> {
  try {
    const resp = await fetch(`${env.LLM_GATEWAY_URL}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.PLATFORM_SECRET}`,
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: `Summarize this conversation in 2-3 sentences, capturing the main topic and key outcomes:\n\n${transcript}`,
          },
        ],
      }),
    });
    if (!resp.ok) return "Summary unavailable.";
    const data = await resp.json<{ content?: { type: string; text: string }[] }>();
    const block = data.content?.find((b) => b.type === "text");
    return block?.text ?? "Summary unavailable.";
  } catch {
    return "Summary unavailable.";
  }
}

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
