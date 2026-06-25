import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  SESSIONS_QUEUE: Queue;
}

interface TriggerRow {
  id: string;
  space_id: string;
  tenant_id: string;
  name: string;
  trigger_type: string;
  cron_expr: string | null;
  event_type: string | null;
  message_template: string;
  enabled: number;
  last_run_at: string | null;
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

app.get("/v1/triggers", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const spaceId = new URL(c.req.url).searchParams.get("space_id");
  const query = spaceId
    ? "SELECT id, name, space_id, trigger_type, cron_expr, event_type, enabled, last_run_at FROM triggers WHERE tenant_id = ? AND space_id = ? ORDER BY name"
    : "SELECT id, name, space_id, trigger_type, cron_expr, event_type, enabled, last_run_at FROM triggers WHERE tenant_id = ? ORDER BY name";
  const stmt = spaceId
    ? c.env.PLATFORM_DB.prepare(query).bind(tenantId, spaceId)
    : c.env.PLATFORM_DB.prepare(query).bind(tenantId);
  const { results } = await stmt.all();
  return c.json({ data: results });
});

app.post("/v1/triggers", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json<{
    name: string;
    space_id: string;
    trigger_type: "schedule" | "event";
    cron_expr?: string;
    event_type?: string;
    message_template: string;
  }>();
  if (!body.name || !body.space_id || !body.trigger_type || !body.message_template) {
    return c.json({ error_code: "bad_request", message: "name, space_id, trigger_type, message_template required" }, 400);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO triggers (id, space_id, tenant_id, name, trigger_type, cron_expr, event_type, message_template, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(id, body.space_id, tenantId, body.name, body.trigger_type, body.cron_expr ?? null, body.event_type ?? null, body.message_template, now, now).run();
  return c.json({ id, name: body.name, trigger_type: body.trigger_type, enabled: true, created_at: now }, 201);
});

app.patch("/v1/triggers/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const triggerId = c.req.param("id");
  const body = await c.req.json<{ enabled?: boolean; message_template?: string }>();
  const now = new Date().toISOString();
  if (body.enabled !== undefined) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE triggers SET enabled = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
    ).bind(body.enabled ? 1 : 0, now, triggerId, tenantId).run();
  }
  if (body.message_template !== undefined) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE triggers SET message_template = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
    ).bind(body.message_template, now, triggerId, tenantId).run();
  }
  return c.json({ id: triggerId, updated_at: now });
});

app.delete("/v1/triggers/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const result = await c.env.PLATFORM_DB.prepare(
    "DELETE FROM triggers WHERE id = ? AND tenant_id = ?"
  ).bind(c.req.param("id"), tenantId).run();
  if (result.meta.changes === 0) return c.json({ error_code: "not_found", message: "Trigger not found" }, 404);
  return c.json({ deleted: true });
});

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
    const { results: triggers } = await env.PLATFORM_DB.prepare(
      "SELECT * FROM triggers WHERE enabled = 1 AND trigger_type = 'schedule'"
    ).all<TriggerRow>();
    const now = new Date().toISOString();
    ctx.waitUntil(Promise.all(triggers.map(async (trigger) => {
      try {
        await env.SESSIONS_QUEUE.send({
          type: "space_trigger",
          spaceId: trigger.space_id,
          tenantId: trigger.tenant_id,
          message: trigger.message_template,
        });
        await env.PLATFORM_DB.prepare(
          "UPDATE triggers SET last_run_at = ? WHERE id = ?"
        ).bind(now, trigger.id).run();
      } catch (err) {
        console.error(`[triggers] Failed to fire trigger ${trigger.id}:`, err);
      }
    })));
  },
} satisfies ExportedHandler<Env>;
