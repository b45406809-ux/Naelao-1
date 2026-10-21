import { Hono } from "hono";
import { errorResponse, requestId, mintInternalToken } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  SESSIONS_QUEUE: Queue;
  /** Direct service binding to agents worker — cron triggers call /script/run (spec §9). */
  AGENTS_WORKER?: Fetcher;
  SPACES_WORKER: Fetcher;
}

interface TriggerRow {
  id: string;
  space_id: string;
  tenant_id: string;
  project_id: string;
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
  return { tenantId: c.req.header("x-naelao-tenant-id") ?? "", userId: c.req.header("x-naelao-user-id") ?? "" };
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

app.get("/v1/triggers", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const spaceId = new URL(c.req.url).searchParams.get("space_id");
  const query = spaceId
    ? `SELECT t.id, t.name, t.space_id, t.trigger_type, t.cron_expr, t.event_type, t.enabled, t.last_run_at
       FROM triggers t JOIN spaces s ON s.id = t.space_id AND s.tenant_id = t.tenant_id AND s.status = 'active'
       JOIN orgs o ON o.id = t.tenant_id AND o.status = 'active'
       WHERE t.tenant_id = ? AND t.space_id = ? ORDER BY t.name`
    : `SELECT t.id, t.name, t.space_id, t.trigger_type, t.cron_expr, t.event_type, t.enabled, t.last_run_at
       FROM triggers t JOIN spaces s ON s.id = t.space_id AND s.tenant_id = t.tenant_id AND s.status = 'active'
       JOIN orgs o ON o.id = t.tenant_id AND o.status = 'active'
       WHERE t.tenant_id = ? ORDER BY t.name`;
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
    project_id: string;
  }>();
  if (!body.name || !body.space_id || !body.project_id || !body.trigger_type || !body.message_template) {
    return c.json({ error_code: "bad_request", message: "name, space_id, project_id, trigger_type, message_template required" }, 400);
  }
  const { userId } = getCallerIdentity(c);
  if (!userId) return c.json({ error_code: "unauthorized", message: "Missing user" }, 401);
  const internalToken = await mintInternalToken(c.env.PLATFORM_SECRET, tenantId);
  const access = await c.env.SPACES_WORKER.fetch(new Request(
    `http://spaces-worker/internal/spaces/${encodeURIComponent(body.space_id)}/projects/${encodeURIComponent(body.project_id)}/automation-access`,
    { headers: { "x-naelao-tenant-id": tenantId, "x-naelao-user-id": userId, "x-naelao-internal-token": internalToken } }
  ));
  if (!access.ok) return new Response(access.body, { status: access.status, headers: { "content-type": "application/json" } });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO triggers (id, space_id, tenant_id, project_id, name, trigger_type, cron_expr, event_type, message_template, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(id, body.space_id, tenantId, body.project_id, body.name, body.trigger_type, body.cron_expr ?? null, body.event_type ?? null, body.message_template, now, now).run();
  return c.json({ id, project_id: body.project_id, name: body.name, trigger_type: body.trigger_type, enabled: true, created_at: now }, 201);
});

app.patch("/v1/triggers/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const triggerId = c.req.param("id");
  const body = await c.req.json<{ enabled?: boolean; message_template?: string }>();
  const now = new Date().toISOString();
  if (body.enabled !== undefined) {
    const result = await c.env.PLATFORM_DB.prepare(
      `UPDATE triggers SET enabled = ?, updated_at = ? WHERE id = ? AND tenant_id = ?
       AND EXISTS (SELECT 1 FROM spaces s JOIN orgs o ON o.id = s.tenant_id
         WHERE s.id = triggers.space_id AND s.tenant_id = triggers.tenant_id AND s.status = 'active' AND o.status = 'active')`
    ).bind(body.enabled ? 1 : 0, now, triggerId, tenantId).run();
    if (result.meta.changes === 0) return c.json({ error_code: "not_found", message: "Trigger not found" }, 404);
  }
  if (body.message_template !== undefined) {
    const result = await c.env.PLATFORM_DB.prepare(
      `UPDATE triggers SET message_template = ?, updated_at = ? WHERE id = ? AND tenant_id = ?
       AND EXISTS (SELECT 1 FROM spaces s JOIN orgs o ON o.id = s.tenant_id
         WHERE s.id = triggers.space_id AND s.tenant_id = triggers.tenant_id AND s.status = 'active' AND o.status = 'active')`
    ).bind(body.message_template, now, triggerId, tenantId).run();
    if (result.meta.changes === 0) return c.json({ error_code: "not_found", message: "Trigger not found" }, 404);
  }
  return c.json({ id: triggerId, updated_at: now });
});

app.delete("/v1/triggers/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const result = await c.env.PLATFORM_DB.prepare(
    `DELETE FROM triggers WHERE id = ? AND tenant_id = ?
     AND EXISTS (SELECT 1 FROM spaces s JOIN orgs o ON o.id = s.tenant_id
       WHERE s.id = triggers.space_id AND s.tenant_id = triggers.tenant_id AND s.status = 'active' AND o.status = 'active')`
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
      `SELECT t.* FROM triggers t
       JOIN spaces s ON s.id = t.space_id AND s.tenant_id = t.tenant_id AND s.status = 'active'
       JOIN orgs o ON o.id = t.tenant_id AND o.status = 'active'
       WHERE t.enabled = 1 AND t.trigger_type = 'schedule'`
    ).all<TriggerRow>();
    const now = new Date().toISOString();
    ctx.waitUntil(Promise.all(triggers.map(async (trigger) => {
      try {
        if (env.AGENTS_WORKER) {
          // Preferred path: call the agent directly via script/run (spec §9 / CLAUDE.md #8).
          // The default agent for any space is "naelao-agent" (DEFAULT_NAELAO_AGENT profile).
          // S0.2: mint a real internal HMAC token — the endpoint no longer accepts the static
          // x-naelao-internal header, since that trusted a caller-chosen tenantId with no proof.
          const internalToken = await mintInternalToken(env.PLATFORM_SECRET, trigger.tenant_id);
          const response = await env.AGENTS_WORKER.fetch(
            new Request("http://agents-worker/agents/naelao-agent/script/run", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-naelao-space-id": trigger.space_id,
                "x-naelao-tenant-id": trigger.tenant_id,
                "x-naelao-internal-token": internalToken,
              },
              body: JSON.stringify({
                goal: trigger.message_template,
                projectId: trigger.project_id,
                sessionId: `cron-${trigger.id}-${Date.now()}`,
                context: { trigger: "schedule", trigger_id: trigger.id, cron_expr: trigger.cron_expr },
              }),
            })
          );
          if (!response.ok) throw new Error(`Agent run failed with status ${response.status}`);
        } else {
          // Fallback: send to sessions queue for async processing
          await env.SESSIONS_QUEUE.send({
            type: "space_trigger",
            spaceId: trigger.space_id,
            projectId: trigger.project_id,
            tenantId: trigger.tenant_id,
            message: trigger.message_template,
          });
        }
        await env.PLATFORM_DB.prepare(
          "UPDATE triggers SET last_run_at = ? WHERE id = ? AND tenant_id = ? AND space_id = ? AND enabled = 1"
        ).bind(now, trigger.id, trigger.tenant_id, trigger.space_id).run();
      } catch (err) {
        console.error(`[triggers] Failed to fire trigger ${trigger.id}:`, err);
      }
    })));
  },
} satisfies ExportedHandler<Env>;
