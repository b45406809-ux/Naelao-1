// G-BE02: Platform Admin Worker — tenant management, feature flags, stats
import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  ADMIN_SECRET: string; // separate secret for admin access
  PLATFORM_DB: D1Database;
  ANALYTICS: AnalyticsEngineDataset;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
  if (!env.ADMIN_SECRET) throw new Error("Missing required secret: ADMIN_SECRET");
}

function requireAdmin(c: { req: { header: (h: string) => string | undefined }; env: Env }): void {
  const role = c.req.header("x-naelao-role") ?? "";
  const adminSecret = c.req.header("x-naelao-admin-secret") ?? "";
  if (role !== "platform_admin" || adminSecret !== c.env.ADMIN_SECRET) {
    throw new Error("Forbidden: platform_admin role required");
  }
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// Middleware: enforce admin role on all routes
app.use("*", async (c, next) => {
  try {
    requireAdmin(c);
  } catch {
    return c.json({ error_code: "forbidden", message: "Admin access required" }, 403);
  }
  return next();
});

// GET /admin/tenants — list all tenants
app.get("/admin/tenants", async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT id, name, plan_tier, status, created_at FROM organizations ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).bind(limit, offset).all();

  return c.json({ data: results, count: results.length });
});

// GET /admin/tenants/:tenantId — get tenant details with stats
app.get("/admin/tenants/:tenantId", async (c) => {
  const tenantId = c.req.param("tenantId");

  const [org, userCount, spaceCount] = await Promise.all([
    c.env.PLATFORM_DB.prepare("SELECT * FROM organizations WHERE id = ?").bind(tenantId).first(),
    c.env.PLATFORM_DB.prepare("SELECT COUNT(*) as count FROM users WHERE org_id = ?").bind(tenantId).first<{ count: number }>(),
    c.env.PLATFORM_DB.prepare("SELECT COUNT(*) as count FROM spaces WHERE tenant_id = ? AND status != 'deleted'").bind(tenantId).first<{ count: number }>(),
  ]);

  if (!org) return c.json({ error_code: "not_found", message: "Tenant not found" }, 404);

  return c.json({ ...org, stats: { users: userCount?.count ?? 0, spaces: spaceCount?.count ?? 0 } });
});

// PATCH /admin/tenants/:tenantId — update tenant plan/status
app.patch("/admin/tenants/:tenantId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const body = await c.req.json<{ plan_tier?: string; status?: string }>();
  const now = new Date().toISOString();

  if (body.plan_tier !== undefined) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE organizations SET plan_tier = ?, updated_at = ? WHERE id = ?"
    ).bind(body.plan_tier, now, tenantId).run();
  }
  if (body.status !== undefined) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE organizations SET status = ?, updated_at = ? WHERE id = ?"
    ).bind(body.status, now, tenantId).run();
  }

  return c.json({ id: tenantId, updated_at: now });
});

// GET /admin/users — list users with search
app.get("/admin/users", async (c) => {
  const url = new URL(c.req.url);
  const email = url.searchParams.get("email") ?? "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);

  const { results } = email
    ? await c.env.PLATFORM_DB.prepare(
        "SELECT id, email, org_id, status, created_at FROM users WHERE email LIKE ? LIMIT ?"
      ).bind(`%${email}%`, limit).all()
    : await c.env.PLATFORM_DB.prepare(
        "SELECT id, email, org_id, status, created_at FROM users ORDER BY created_at DESC LIMIT ?"
      ).bind(limit).all();

  return c.json({ data: results });
});

// POST /admin/feature-flags — set a feature flag
app.post("/admin/feature-flags", async (c) => {
  const body = await c.req.json<{ key: string; value: unknown; tenant_id?: string }>();
  if (!body.key) return c.json({ error_code: "bad_request", message: "key is required" }, 400);

  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO feature_flags (id, key, value_json, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key, tenant_id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).bind(
    crypto.randomUUID(),
    body.key,
    JSON.stringify(body.value),
    body.tenant_id ?? null,
    now,
    now,
  ).run();

  return c.json({ key: body.key, value: body.value, tenant_id: body.tenant_id ?? null });
});

// GET /admin/feature-flags — list feature flags
app.get("/admin/feature-flags", async (c) => {
  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT key, value_json, tenant_id, updated_at FROM feature_flags ORDER BY key"
  ).all<{ key: string; value_json: string; tenant_id: string | null; updated_at: string }>();

  return c.json({
    data: results.map(r => ({
      key: r.key,
      value: JSON.parse(r.value_json) as unknown,
      tenant_id: r.tenant_id,
      updated_at: r.updated_at,
    })),
  });
});

// GET /admin/stats — platform-wide stats
app.get("/admin/stats", async (c) => {
  const [tenants, users, spaces, sessions] = await Promise.all([
    c.env.PLATFORM_DB.prepare("SELECT COUNT(*) as count FROM organizations WHERE status = 'active'").first<{ count: number }>(),
    c.env.PLATFORM_DB.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'active'").first<{ count: number }>(),
    c.env.PLATFORM_DB.prepare("SELECT COUNT(*) as count FROM spaces WHERE status = 'active'").first<{ count: number }>(),
    c.env.PLATFORM_DB.prepare("SELECT COUNT(*) as count FROM sessions WHERE created_at > datetime('now', '-24 hours')").first<{ count: number }>(),
  ]);

  return c.json({
    active_tenants: tenants?.count ?? 0,
    active_users: users?.count ?? 0,
    active_spaces: spaces?.count ?? 0,
    sessions_24h: sessions?.count ?? 0,
    timestamp: new Date().toISOString(),
  });
});

// G-P10: Audit log endpoint — CF Analytics Engine with parameterized queries (no SQL injection)
// GET /admin/audit?space_id=xxx&event_type=yyy&limit=50
// G-P10 Required Fix: parameterize all dynamic values — never template-literal AE queries.
const ALLOWED_EVENT_TYPES = new Set([
  "session.created", "session.ended", "message.sent", "tool.called",
  "llm.request", "kb.search", "space.created", "space.deleted",
  "user.login", "user.logout", "credential.accessed", "injection.detected",
  "quota.exceeded", "erasure.completed", "export.requested",
]);

app.get("/admin/audit", async (c) => {
  const url = new URL(c.req.url);
  const spaceId = url.searchParams.get("space_id") ?? "";
  const rawEventType = url.searchParams.get("event_type") ?? "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);

  if (!spaceId) return c.json({ error_code: "bad_request", message: "space_id is required" }, 400);

  // G-P10: Validate event_type against allowlist before using in query
  const eventType = rawEventType && ALLOWED_EVENT_TYPES.has(rawEventType) ? rawEventType : null;

  // G-P10: Use parameterized AE query — never string interpolation
  // CF Analytics Engine SQL uses ? positional params
  let queryText: string;
  let params: unknown[];

  if (eventType) {
    queryText = "SELECT blob1 as event_type, blob2 as space_id, blob3 as user_id, blob4 as session_id, double1 as ts FROM ANALYTICS WHERE blob2 = ? AND blob1 = ? ORDER BY double1 DESC LIMIT ?";
    params = [spaceId, eventType, limit];
  } else {
    queryText = "SELECT blob1 as event_type, blob2 as space_id, blob3 as user_id, blob4 as session_id, double1 as ts FROM ANALYTICS WHERE blob2 = ? ORDER BY double1 DESC LIMIT ?";
    params = [spaceId, limit];
  }

  try {
    const result = await (c.env.ANALYTICS as unknown as { query: (sql: string, ...params: unknown[]) => Promise<{ results: unknown[] }> }).query(queryText, ...params);
    return c.json({ data: result.results, count: result.results.length });
  } catch (err) {
    console.error("[admin/audit] AE query error:", err);
    return c.json({ error_code: "internal_error", message: "Failed to query audit log" }, 500);
  }
});

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
