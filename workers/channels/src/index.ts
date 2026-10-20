// G-CH01..G-CH08: Channels — inbound email, Slack events, generic webhooks → sessions
import { Hono } from "hono";
import { errorResponse, readBoundedRequestText, requestId } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  CHANNEL_CONFIG: KVNamespace;
  SESSIONS_QUEUE: Queue;
}

interface ChannelConfig {
  space_id: string;
  tenant_id: string;
  channel_type: "email" | "slack" | "webhook";
  routing_key: string;
  enabled: number;
}

interface SessionQueueMessage {
  type: "inbound_channel";
  channel_type: string;
  space_id: string;
  tenant_id: string;
  end_user_id: string;
  content: string;
  metadata: Record<string, unknown>;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }) {
  return { tenantId: c.req.header("x-naelao-tenant-id") ?? "" };
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// ---- Channel configuration CRUD ----

app.get("/v1/channels", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT id, space_id, channel_type, routing_key, enabled, created_at FROM channels WHERE tenant_id = ? ORDER BY created_at DESC"
  ).bind(tenantId).all();
  return c.json({ data: results });
});

app.post("/v1/channels", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json<{ space_id: string; channel_type: "email" | "slack" | "webhook"; routing_key?: string }>();
  if (!body.space_id || !body.channel_type) {
    return c.json({ error_code: "bad_request", message: "space_id and channel_type required" }, 400);
  }
  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM spaces WHERE id = ? AND tenant_id = ?"
  ).bind(body.space_id, tenantId).first<{ id: string }>();
  if (!space) return c.json({ error_code: "not_found", message: "Space not found" }, 404);

  // WS-7 (audit plan): a client-supplied routing_key was written straight to a GLOBAL KV key
  // (`channel:${routing_key}`) with no ownership check — any tenant could overwrite another
  // tenant's routing config (or race to claim a key before its rightful owner did), silently
  // hijacking that tenant's inbound email/Slack/webhook traffic. A client-supplied key is only
  // honored when no OTHER tenant already owns it; otherwise this is rejected outright rather than
  // silently namespaced (a builder who intentionally chose a memorable key expects to see the
  // conflict, not have it renamed for them).
  const routingKey = body.routing_key ?? crypto.randomUUID();
  if (body.routing_key) {
    const existing = await c.env.CHANNEL_CONFIG.get(`channel:${body.routing_key}`);
    if (existing) {
      const existingConfig = JSON.parse(existing) as ChannelConfig;
      if (existingConfig.tenant_id !== tenantId) {
        return c.json({ error_code: "conflict", message: "routing_key is already in use" }, 409);
      }
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO channels (id, space_id, tenant_id, channel_type, routing_key, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(id, body.space_id, tenantId, body.channel_type, routingKey, now, now).run();
  // Cache config in KV for fast inbound lookup
  const config: ChannelConfig = { space_id: body.space_id, tenant_id: tenantId, channel_type: body.channel_type, routing_key: routingKey, enabled: 1 };
  await c.env.CHANNEL_CONFIG.put(`channel:${routingKey}`, JSON.stringify(config));
  return c.json({ id, routing_key: routingKey, channel_type: body.channel_type, enabled: true, created_at: now }, 201);
});

app.delete("/v1/channels/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const row = await c.env.PLATFORM_DB.prepare(
    "SELECT routing_key FROM channels WHERE id = ? AND tenant_id = ?"
  ).bind(c.req.param("id"), tenantId).first<{ routing_key: string }>();
  if (!row) return c.json({ error_code: "not_found", message: "Channel not found" }, 404);
  await c.env.PLATFORM_DB.prepare("DELETE FROM channels WHERE id = ? AND tenant_id = ?").bind(c.req.param("id"), tenantId).run();
  await c.env.CHANNEL_CONFIG.delete(`channel:${row.routing_key}`);
  return c.json({ deleted: true });
});

// ---- Inbound handlers ----

// CF Email Routing handler — receives forwarded emails
app.post("/inbound/email/:routingKey", async (c) => {
  const routingKey = c.req.param("routingKey");
  const configJson = await c.env.CHANNEL_CONFIG.get(`channel:${routingKey}`);
  if (!configJson) return new Response("Not found", { status: 404 });
  const config = JSON.parse(configJson) as ChannelConfig;
  if (!config.enabled) return new Response("Channel disabled", { status: 403 });

  const body = await c.req.json<{
    from?: string;
    subject?: string;
    text?: string;
    html?: string;
    message_id?: string;
  }>();

  const content = body.text ?? body.html ?? "";
  const subject = body.subject ?? "(no subject)";
  const from = body.from ?? "unknown@email";
  const endUserId = `email:${from}`;

  await c.env.SESSIONS_QUEUE.send({
    type: "inbound_channel",
    channel_type: "email",
    space_id: config.space_id,
    tenant_id: config.tenant_id,
    end_user_id: endUserId,
    content: `Subject: ${subject}\n\n${content}`,
    metadata: { from, subject, message_id: body.message_id ?? null },
  } satisfies SessionQueueMessage);

  return new Response("OK", { status: 200 });
});

// Slack Events API handler
app.post("/inbound/slack/:routingKey", async (c) => {
  const routingKey = c.req.param("routingKey");
  const body = await c.req.json<{
    type?: string;
    challenge?: string;
    event?: {
      type: string;
      text?: string;
      user?: string;
      channel?: string;
      ts?: string;
    };
  }>();

  // Slack URL verification challenge
  if (body.type === "url_verification") {
    return c.json({ challenge: body.challenge });
  }

  const configJson = await c.env.CHANNEL_CONFIG.get(`channel:${routingKey}`);
  if (!configJson) return new Response("Not found", { status: 404 });
  const config = JSON.parse(configJson) as ChannelConfig;
  if (!config.enabled) return new Response("Channel disabled", { status: 403 });

  if (body.type !== "event_callback" || body.event?.type !== "message") {
    return new Response("OK", { status: 200 });
  }

  const event = body.event;
  const content = event.text ?? "";
  const endUserId = `slack:${event.user ?? "unknown"}`;

  await c.env.SESSIONS_QUEUE.send({
    type: "inbound_channel",
    channel_type: "slack",
    space_id: config.space_id,
    tenant_id: config.tenant_id,
    end_user_id: endUserId,
    content,
    metadata: { slack_user: event.user, slack_channel: event.channel, slack_ts: event.ts },
  } satisfies SessionQueueMessage);

  return new Response("OK", { status: 200 });
});

// Generic webhook handler — any HTTP POST
app.post("/inbound/webhook/:routingKey", async (c) => {
  const routingKey = c.req.param("routingKey");
  const configJson = await c.env.CHANNEL_CONFIG.get(`channel:${routingKey}`);
  if (!configJson) return new Response("Not found", { status: 404 });
  const config = JSON.parse(configJson) as ChannelConfig;
  if (!config.enabled) return new Response("Channel disabled", { status: 403 });

  let body: Record<string, unknown> = {};
  let raw: string;
  try { raw = await readBoundedRequestText(c.req.raw, 1024 * 1024); }
  catch { return c.json({ error_code: "payload_too_large" }, 413); }
  try { body = JSON.parse(raw) as Record<string, unknown>; }
  catch { body = { raw }; }

  const content = typeof body["content"] === "string"
    ? body["content"]
    : typeof body["message"] === "string"
      ? body["message"]
      : JSON.stringify(body).slice(0, 4000);

  const endUserId = typeof body["user_id"] === "string"
    ? `webhook:${body["user_id"]}`
    : `webhook:${crypto.randomUUID()}`;

  await c.env.SESSIONS_QUEUE.send({
    type: "inbound_channel",
    channel_type: "webhook",
    space_id: config.space_id,
    tenant_id: config.tenant_id,
    end_user_id: endUserId,
    content,
    metadata: { source: body["source"] ?? null, webhook_routing_key: routingKey },
  } satisfies SessionQueueMessage);

  return c.json({ queued: true });
});

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
