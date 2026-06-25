// G-AS01..G-AS06: Platform-level Claude assistant for builders — pre-loaded with platform docs KB
import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  PLATFORM_DOCS_INDEX: VectorizeIndex;
  LLM_GATEWAY_URL: string;
}

interface AssistantSession {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string | null;
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

const SYSTEM_PROMPT = `You are the Naelao platform assistant. You help builders create, configure, and manage their AI Spaces.

Key concepts:
- SpaceType: a blueprint/product definition for an AI Space
- Template: a builder-configurable selection (no coding required)
- Space: a deployed instance of a SpaceType with specific configuration
- KB: knowledge base documents embedded in Vectorize for semantic retrieval
- AgentDO: Durable Object running the ReAct agent loop
- Sessions: conversations between end-users and a Space's agent

You have access to platform documentation. Always cite specific features when helping.
Be concise, practical, and accurate. If unsure, say so.`;

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// List assistant sessions for the caller
app.get("/v1/assistant/sessions", async (c) => {
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized", message: "Missing tenant or user" }, 401);
  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT id, title, created_at FROM assistant_sessions WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50"
  ).bind(tenantId, userId).all<AssistantSession>();
  return c.json({ data: results });
});

// Get session messages
app.get("/v1/assistant/sessions/:id", async (c) => {
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized", message: "Missing tenant or user" }, 401);
  const session = await c.env.PLATFORM_DB.prepare(
    "SELECT id, title, created_at FROM assistant_sessions WHERE id = ? AND tenant_id = ? AND user_id = ?"
  ).bind(c.req.param("id"), tenantId, userId).first<AssistantSession>();
  if (!session) return c.json({ error_code: "not_found", message: "Session not found" }, 404);
  const { results: messages } = await c.env.PLATFORM_DB.prepare(
    "SELECT role, content, created_at FROM assistant_messages WHERE session_id = ? ORDER BY created_at ASC"
  ).bind(session.id).all();
  return c.json({ data: { ...session, messages } });
});

// Send a message (creates session if session_id omitted)
app.post("/v1/assistant/chat", async (c) => {
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized", message: "Missing tenant or user" }, 401);
  const body = await c.req.json<{ message: string; session_id?: string }>();
  if (!body.message?.trim()) {
    return c.json({ error_code: "bad_request", message: "message required" }, 400);
  }
  const now = new Date().toISOString();

  // Resolve or create session
  let sessionId = body.session_id;
  if (sessionId) {
    const existing = await c.env.PLATFORM_DB.prepare(
      "SELECT id FROM assistant_sessions WHERE id = ? AND tenant_id = ? AND user_id = ?"
    ).bind(sessionId, tenantId, userId).first<{ id: string }>();
    if (!existing) return c.json({ error_code: "not_found", message: "Session not found" }, 404);
  } else {
    sessionId = crypto.randomUUID();
    const title = body.message.slice(0, 80);
    await c.env.PLATFORM_DB.prepare(
      "INSERT INTO assistant_sessions (id, tenant_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(sessionId, tenantId, userId, title, now, now).run();
  }

  // Load conversation history (last 20 turns)
  const { results: history } = await c.env.PLATFORM_DB.prepare(
    "SELECT role, content FROM assistant_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 40"
  ).bind(sessionId).all<{ role: string; content: string }>();
  const priorMessages = history.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // Retrieve relevant docs from Vectorize
  const kbContext = await retrievePlatformDocs(body.message, c.env);

  // Build messages for LLM
  const systemWithKb = kbContext
    ? `${SYSTEM_PROMPT}\n\n<kb_content>\n${kbContext}\n</kb_content>`
    : SYSTEM_PROMPT;

  const llmMessages = [
    ...priorMessages,
    { role: "user" as const, content: body.message },
  ];

  // Call LLM gateway
  const reply = await callLlm(systemWithKb, llmMessages, c.env);

  // Persist messages
  const userMsgId = crypto.randomUUID();
  const assistantMsgId = crypto.randomUUID();
  await c.env.PLATFORM_DB.prepare(
    "INSERT INTO assistant_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)"
  ).bind(userMsgId, sessionId, body.message, now).run();
  await c.env.PLATFORM_DB.prepare(
    "INSERT INTO assistant_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)"
  ).bind(assistantMsgId, sessionId, reply, now).run();
  await c.env.PLATFORM_DB.prepare(
    "UPDATE assistant_sessions SET updated_at = ? WHERE id = ?"
  ).bind(now, sessionId).run();

  return c.json({ session_id: sessionId, message: reply, created_at: now });
});

// Delete session
app.delete("/v1/assistant/sessions/:id", async (c) => {
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized", message: "Missing tenant or user" }, 401);
  await c.env.PLATFORM_DB.prepare(
    "DELETE FROM assistant_messages WHERE session_id = ?"
  ).bind(c.req.param("id")).run();
  const result = await c.env.PLATFORM_DB.prepare(
    "DELETE FROM assistant_sessions WHERE id = ? AND tenant_id = ? AND user_id = ?"
  ).bind(c.req.param("id"), tenantId, userId).run();
  if (result.meta.changes === 0) return c.json({ error_code: "not_found", message: "Session not found" }, 404);
  return c.json({ deleted: true });
});

async function retrievePlatformDocs(query: string, env: Env): Promise<string> {
  try {
    const resp = await fetch(`${env.LLM_GATEWAY_URL}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.PLATFORM_SECRET}` },
      body: JSON.stringify({ input: query, model: "text-embedding-3-small" }),
    });
    if (!resp.ok) return "";
    const data = await resp.json<{ data: { embedding: number[] }[] }>();
    const embedding = data.data[0]?.embedding;
    if (!embedding) return "";

    const results = await env.PLATFORM_DOCS_INDEX.query(embedding, { topK: 5, returnMetadata: "indexed" });
    return results.matches.map((m) => (m.metadata as Record<string, string>)["text"] ?? "").filter(Boolean).join("\n\n");
  } catch {
    return "";
  }
}

async function callLlm(
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  env: Env
): Promise<string> {
  try {
    const resp = await fetch(`${env.LLM_GATEWAY_URL}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.PLATFORM_SECRET}` },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system,
        messages,
      }),
    });
    if (!resp.ok) return "I encountered an error. Please try again.";
    const data = await resp.json<{ content?: { type: string; text: string }[] }>();
    const block = data.content?.find((b) => b.type === "text");
    return block?.text ?? "I encountered an error. Please try again.";
  } catch {
    return "I encountered an error. Please try again.";
  }
}

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
