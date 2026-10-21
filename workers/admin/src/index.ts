// G-BE02: Platform Admin Worker — tenant management, feature flags, stats
import { Hono } from "hono";
import { errorResponse, parseBoundedInteger, requestId } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  ADMIN_SECRET: string; // separate secret for admin access
  PLATFORM_DB: D1Database;
  ANALYTICS: AnalyticsEngineDataset;
}

// ── G-D11: DLQ consumer — persist dead-letter messages before 4-day CF expiry ──

interface DlqMessage {
  type?: string;
  message_type?: string;
  [key: string]: unknown;
}

export async function queue(
  batch: MessageBatch<DlqMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    const messageType = body.type ?? body.message_type ?? "unknown";
    const now = new Date().toISOString();

    try {
      // Persist to D1 platform_failures table for operator review
      await env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO platform_failures (id, message_type, payload_json, failure_reason, failed_at, retry_count, reviewed)
         VALUES (?, ?, ?, ?, ?, 0, 0)`
      )
        .bind(
          `dlq:${message.id}`,
          messageType,
          JSON.stringify(body),
          `DLQ: exhausted retries for message type=${messageType}`,
          now
        )
        .run();

      // Log for operator alert visibility
      console.error(
        `[admin/dlq] PERMANENT FAILURE type=${messageType} at=${now} body=${JSON.stringify(body).slice(0, 500)}`
      );

      message.ack();
    } catch (err) {
      console.error("[admin/dlq] Failed to write platform_failure record:", err);
      message.retry();
    }
  }
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
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, 1, 200);
  const offset = parseBoundedInteger(url.searchParams.get("offset"), 0, 0, 100_000);

  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT id, name, plan_tier, status, created_at FROM orgs ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).bind(limit, offset).all();

  return c.json({ data: results, count: results.length });
});

// GET /admin/tenants/:tenantId — get tenant details with stats
app.get("/admin/tenants/:tenantId", async (c) => {
  const tenantId = c.req.param("tenantId");

  const [org, userCount, spaceCount] = await Promise.all([
    c.env.PLATFORM_DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(tenantId).first(),
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
      "UPDATE orgs SET plan_tier = ?, updated_at = ? WHERE id = ?"
    ).bind(body.plan_tier, now, tenantId).run();
  }
  if (body.status !== undefined) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE orgs SET status = ?, updated_at = ? WHERE id = ?"
    ).bind(body.status, now, tenantId).run();
  }

  return c.json({ id: tenantId, updated_at: now });
});

// GET /admin/users — list users with search
app.get("/admin/users", async (c) => {
  const url = new URL(c.req.url);
  const email = url.searchParams.get("email") ?? "";
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, 1, 200);

  const { results } = email
    ? await c.env.PLATFORM_DB.prepare(
        "SELECT id, email, org_id, status, created_at FROM users WHERE email LIKE ? LIMIT ?"
      ).bind(`%${email}%`, limit).all()
    : await c.env.PLATFORM_DB.prepare(
        "SELECT id, email, org_id, status, created_at FROM users ORDER BY created_at DESC LIMIT ?"
      ).bind(limit).all();

  return c.json({ data: results });
});

// POST /admin/feature-flags — set a platform-wide gradual-rollout flag (infra/migrations/
// 0023_feature_flags.sql: name/enabled/rollout_pct/overrides_json — NOT the same table as
// FeatureFlagDO, which owns its own per-DO SQLite `flags` table; this D1 table is the platform
// operator's own rollout registry, distinct from both FeatureFlagDO and a builder's per-product
// productConfig.featureFlags). Previously queried a `key`/`value_json`/`tenant_id` shape that
// migration 0023 never created and an `ON CONFLICT(key, tenant_id)` target with no matching
// UNIQUE constraint — every call would have thrown a D1 error; fixed to match the real schema.
app.post("/admin/feature-flags", async (c) => {
  const body = await c.req.json<{
    name: string;
    enabled?: boolean;
    rollout_pct?: number;
    description?: string;
    overrides?: Record<string, boolean>;
  }>();
  if (!body.name) return c.json({ error_code: "bad_request", message: "name is required" }, 400);

  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO feature_flags (id, name, description, enabled, rollout_pct, overrides_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       description = excluded.description,
       enabled = excluded.enabled,
       rollout_pct = excluded.rollout_pct,
       overrides_json = excluded.overrides_json,
       updated_at = excluded.updated_at`
  ).bind(
    crypto.randomUUID(),
    body.name,
    body.description ?? null,
    body.enabled ? 1 : 0,
    body.rollout_pct ?? 0,
    JSON.stringify(body.overrides ?? {}),
    now,
    now,
  ).run();

  return c.json({
    name: body.name,
    enabled: body.enabled ?? false,
    rollout_pct: body.rollout_pct ?? 0,
    overrides: body.overrides ?? {},
  });
});

// GET /admin/feature-flags — list platform-wide rollout flags
app.get("/admin/feature-flags", async (c) => {
  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT name, description, enabled, rollout_pct, overrides_json, updated_at FROM feature_flags ORDER BY name"
  ).all<{ name: string; description: string | null; enabled: number; rollout_pct: number; overrides_json: string; updated_at: string }>();

  return c.json({
    data: results.map((r) => ({
      name: r.name,
      description: r.description,
      enabled: r.enabled === 1,
      rollout_pct: r.rollout_pct,
      overrides: JSON.parse(r.overrides_json) as Record<string, boolean>,
      updated_at: r.updated_at,
    })),
  });
});

// GET /admin/stats — platform-wide stats
app.get("/admin/stats", async (c) => {
  const [tenants, users, spaces] = await Promise.all([
    c.env.PLATFORM_DB.prepare("SELECT COUNT(*) as count FROM orgs WHERE status = 'active'").first<{ count: number }>(),
    c.env.PLATFORM_DB.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'active'").first<{ count: number }>(),
    c.env.PLATFORM_DB.prepare("SELECT COUNT(*) as count FROM spaces WHERE status = 'active'").first<{ count: number }>(),
  ]);

  return c.json({
    active_tenants: tenants?.count ?? 0,
    active_users: users?.count ?? 0,
    active_spaces: spaces?.count ?? 0,
    // Found while reconciling this file's other table-name bugs: this previously queried a D1
    // `sessions` table that has never existed (sessions/messages live in each SpaceDO's own
    // per-space SQLite, not D1 — there's no single-query cross-space aggregate). The whole
    // Promise.all threw on every call, so /admin/stats has always 500'd. Honest null (same
    // precedent as the Builder Dashboard's credits_consumed: null) rather than fabricating a
    // number — a real 24h-active-sessions count needs Analytics Engine wiring, not D1.
    sessions_24h: null,
    timestamp: new Date().toISOString(),
  });
});

// G-D11: Platform failures (DLQ) dashboard endpoint
// GET /admin/failures?reviewed=0&limit=50
app.get("/admin/failures", async (c) => {
  const url = new URL(c.req.url);
  const reviewed = url.searchParams.get("reviewed") ?? "0";
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, 1, 200);

  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT id, message_type, payload_json, failure_reason, failed_at, retry_count, reviewed
     FROM platform_failures
     WHERE reviewed = ?
     ORDER BY failed_at DESC
     LIMIT ?`
  ).bind(parseInt(reviewed, 10), limit).all();

  return c.json({ data: results, count: results.length });
});

// PATCH /admin/failures/:id/reviewed — mark a failure as reviewed
app.patch("/admin/failures/:id/reviewed", async (c) => {
  const result = await c.env.PLATFORM_DB.prepare(
    "UPDATE platform_failures SET reviewed = 1 WHERE id = ?"
  ).bind(c.req.param("id")).run();

  if (result.meta.changes === 0) return c.json({ error_code: "not_found", message: "Failure not found" }, 404);
  return c.json({ reviewed: true });
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
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, 1, 200);

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

// ── Product kill-switch — abuse response runbook ─────────────────────────────────────────────
// POST /admin/products/:spaceId/suspend — immediately set space status='suspended', preventing
// any further end-user logins (ProductUserDO session verification fails against a suspended
// space) and agent runs (subscription gate, credit gate, and run dispatcher all read the
// current space row). Use this when a product is hosting phishing, illegal content, or
// violating platform ToS. Irreversible by this route alone — an operator must explicitly
// restore via /admin/products/:spaceId/restore.
// Runbook: (1) receive abuse report or automated alert; (2) verify the space_id from the
// product_slug (GET /admin/products/search?slug=...); (3) POST /admin/products/:id/suspend
// with reason — the audit log records who, when, and why; (4) if also a GDPR/law-enforcement
// hold is needed, also call POST /admin/tenants/:tenantId (status=suspended) to freeze the
// whole org; (5) notify the builder via email with the specific ToS clause violated; (6) if
// legitimate, restore with /admin/products/:id/restore, else schedule deletion after 30 days.
app.get("/admin/products/search", async (c) => {
  const slug = c.req.query("slug") ?? "";
  if (!slug) return c.json({ error_code: "bad_request", message: "slug is required" }, 400);
  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT id, tenant_id, name, status, product_slug, created_at FROM spaces WHERE product_slug = ? LIMIT 1"
  ).bind(slug).first();
  if (!space) return c.json({ error_code: "not_found", message: "No product with that slug" }, 404);
  return c.json(space);
});

app.post("/admin/products/:spaceId/suspend", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { reason } = await c.req.json<{ reason: string }>();
  if (!reason?.trim()) return c.json({ error_code: "bad_request", message: "reason is required for audit trail" }, 400);
  const space = await c.env.PLATFORM_DB.prepare("SELECT id, status FROM spaces WHERE id = ?").bind(spaceId).first<{ id: string; status: string }>();
  if (!space) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  if (space.status === "suspended") return c.json({ ok: true, already_suspended: true });
  await c.env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'suspended', updated_at = datetime('now') WHERE id = ?"
  ).bind(spaceId).run();
  // Audit trail — same table pattern as /admin/failures.
  await c.env.PLATFORM_DB.prepare(
    "INSERT INTO platform_failures (id, message_type, payload_json, failure_reason, failed_at, retry_count, reviewed) VALUES (?, ?, ?, ?, datetime('now'), 0, 0)"
  ).bind(crypto.randomUUID(), "admin_product_suspend", JSON.stringify({ space_id: spaceId }), `Admin suspend: ${reason}`).run().catch(() => {});
  console.warn(`[admin] PRODUCT SUSPENDED space=${spaceId} reason=${reason}`);
  return c.json({ ok: true, suspended: true });
});

app.post("/admin/products/:spaceId/restore", async (c) => {
  const spaceId = c.req.param("spaceId");
  const space = await c.env.PLATFORM_DB.prepare("SELECT id, status FROM spaces WHERE id = ?").bind(spaceId).first<{ id: string; status: string }>();
  if (!space) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  await c.env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status = 'suspended'"
  ).bind(spaceId).run();
  await c.env.PLATFORM_DB.prepare(
    "INSERT INTO platform_failures (id, message_type, payload_json, failure_reason, failed_at, retry_count, reviewed) VALUES (?, ?, ?, ?, datetime('now'), 0, 0)"
  ).bind(crypto.randomUUID(), "admin_product_restore", JSON.stringify({ space_id: spaceId }), "Admin restore").run().catch(() => {});
  console.warn(`[admin] PRODUCT RESTORED space=${spaceId}`);
  return c.json({ ok: true, restored: true });
});

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));
export default {
  fetch: app.fetch,
  queue: queue as ExportedHandlerQueueHandler<Env>,
} satisfies ExportedHandler<Env>;
