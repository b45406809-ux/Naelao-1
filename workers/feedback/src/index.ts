// G-BE01: Message Feedback Worker — thumbs up/down ratings with analytics
import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  ANALYTICS?: AnalyticsEngineDataset; // optional — write if bound
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }) {
  return {
    tenantId: c.req.header("x-naelao-tenant-id") ?? "",
    userId: c.req.header("x-naelao-user-id") ?? "",
  };
}

// POST /v1/sessions/:sessionId/messages/:messageId/feedback
app.post("/v1/sessions/:sessionId/messages/:messageId/feedback", async (c) => {
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const sessionId = c.req.param("sessionId");
  const messageId = c.req.param("messageId");

  const body = await c.req.json<{
    rating: "thumbs_up" | "thumbs_down";
    comment?: string;
    space_id?: string;
  }>();

  if (body.rating !== "thumbs_up" && body.rating !== "thumbs_down") {
    return c.json({ error_code: "bad_request", message: "rating must be thumbs_up or thumbs_down" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO message_feedback (id, session_id, message_id, tenant_id, user_id, space_id, rating, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    sessionId,
    messageId,
    tenantId,
    userId || null,
    body.space_id ?? null,
    body.rating,
    body.comment ?? null,
    now,
  ).run();

  // Fire-and-forget analytics write
  if (c.env.ANALYTICS) {
    try {
      c.env.ANALYTICS.writeDataPoint({
        blobs: [tenantId, body.space_id ?? "", sessionId, messageId, body.rating],
        doubles: [body.rating === "thumbs_up" ? 1 : 0],
        indexes: [tenantId],
      });
    } catch { /* best-effort */ }
  }

  return c.json({ id, rating: body.rating, created_at: now }, 201);
});

// GET /v1/sessions/:sessionId/feedback — get all feedback for a session
app.get("/v1/sessions/:sessionId/feedback", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const sessionId = c.req.param("sessionId");

  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT id, message_id, rating, comment, created_at FROM message_feedback WHERE session_id = ? AND tenant_id = ? ORDER BY created_at DESC"
  ).bind(sessionId, tenantId).all();

  return c.json({ data: results });
});

// GET /v1/spaces/:spaceId/feedback/summary — weekly quality score
app.get("/v1/spaces/:spaceId/feedback/summary", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const spaceId = c.req.param("spaceId");

  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN rating = 'thumbs_up' THEN 1 ELSE 0 END) as positive,
       SUM(CASE WHEN rating = 'thumbs_down' THEN 1 ELSE 0 END) as negative
     FROM message_feedback
     WHERE space_id = ? AND tenant_id = ? AND created_at > datetime('now', '-7 days')`
  ).bind(spaceId, tenantId).first<{ total: number; positive: number; negative: number }>();

  const total = row?.total ?? 0;
  const positive = row?.positive ?? 0;
  const score = total > 0 ? Math.round((positive / total) * 100) : null;

  return c.json({
    space_id: spaceId,
    period_days: 7,
    total,
    positive,
    negative: row?.negative ?? 0,
    quality_score: score,
  });
});

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
