// G-N01: Notifications worker — email + in-app notification consumer
import { badRequest, errorResponse, notFound, requestId } from "@naelao/http";
import { Hono } from "hono";

// ── Env ───────────────────────────────────────────────────────────────────────

export interface NotificationsEnv {
  ENVIRONMENT: string;
  RESEND_API_KEY: string;
  RESEND_API_URL: string;
  WEBHOOK_SIGNING_SECRET: string;
  PLATFORM_DB: D1Database;
}

function validateEnv(env: NotificationsEnv): void {
  if (!env.RESEND_API_KEY) throw new Error("Missing required secret: RESEND_API_KEY");
  if (!env.WEBHOOK_SIGNING_SECRET) throw new Error("Missing required secret: WEBHOOK_SIGNING_SECRET");
}

// ── Queue message type ────────────────────────────────────────────────────────

interface NotificationMessage {
  type: "email" | "in_app" | "webhook";
  tenantId: string;
  userId?: string;
  email?: string;
  subject?: string;
  html?: string;
  templateId?: string;
  data?: Record<string, unknown>;
  webhookUrl?: string;
}

// ── HMAC helper ───────────────────────────────────────────────────────────────

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", keyMaterial, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Email template loader ─────────────────────────────────────────────────────

async function loadEmailTemplate(
  db: D1Database,
  templateId: string,
  tenantId: string
): Promise<{ subject: string; html: string } | null> {
  const row = await db
    .prepare(
      "SELECT subject, html FROM email_templates WHERE id = ? AND tenant_id = ? LIMIT 1"
    )
    .bind(templateId, tenantId)
    .first<{ subject: string; html: string }>();
  return row ?? null;
}

// ── Queue consumer ────────────────────────────────────────────────────────────

export async function queue(
  batch: MessageBatch<NotificationMessage>,
  env: NotificationsEnv
): Promise<void> {
  for (const message of batch.messages) {
    const msg = message.body;
    try {
      switch (msg.type) {
        case "email": {
          let subject = msg.subject ?? "(no subject)";
          let html = msg.html ?? "";

          // Load template from D1 if templateId is provided
          if (msg.templateId) {
            const tmpl = await loadEmailTemplate(env.PLATFORM_DB, msg.templateId, msg.tenantId);
            if (tmpl) {
              subject = tmpl.subject;
              html = tmpl.html;
            }
          }

          if (!msg.email) {
            console.warn("[notifications/queue] email message missing email address, acking");
            message.ack();
            break;
          }

          const res = await fetch(`${env.RESEND_API_URL}/emails`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${env.RESEND_API_KEY}`,
            },
            body: JSON.stringify({
              from: "noreply@naelao.com",
              to: msg.email,
              subject,
              html,
            }),
          });

          if (!res.ok) {
            console.error(
              `[notifications/queue] Resend API error ${res.status} for email=${msg.email}`
            );
            message.retry();
            break;
          }

          // Record sent notification in D1
          await env.PLATFORM_DB.prepare(
            `INSERT INTO notifications (id, tenant_id, user_id, type, status, subject, created_at)
             VALUES (?, ?, ?, 'email', 'sent', ?, datetime('now'))`
          )
            .bind(
              crypto.randomUUID(),
              msg.tenantId,
              msg.userId ?? null,
              subject
            )
            .run();

          message.ack();
          break;
        }

        case "in_app": {
          await env.PLATFORM_DB.prepare(
            `INSERT INTO notifications (id, tenant_id, user_id, type, status, subject, created_at)
             VALUES (?, ?, ?, 'in_app', 'unread', ?, datetime('now'))`
          )
            .bind(
              crypto.randomUUID(),
              msg.tenantId,
              msg.userId ?? null,
              msg.subject ?? null
            )
            .run();

          message.ack();
          break;
        }

        case "webhook": {
          if (!msg.webhookUrl) {
            console.warn("[notifications/queue] webhook message missing webhookUrl, acking");
            message.ack();
            break;
          }

          const body = JSON.stringify(msg.data ?? {});
          const signature = await hmacSha256Hex(body, env.WEBHOOK_SIGNING_SECRET);

          const res = await fetch(msg.webhookUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Naelao-Signature": signature,
            },
            body,
          });

          if (!res.ok) {
            console.error(
              `[notifications/queue] webhook delivery failed status=${res.status} url=${msg.webhookUrl}`
            );
            message.retry();
            break;
          }

          message.ack();
          break;
        }

        default: {
          // Exhaust the union — TypeScript will warn if a case is unhandled
          const _exhaustive: never = msg.type;
          console.warn("[notifications/queue] unknown message type, acking", _exhaustive);
          message.ack();
          break;
        }
      }
    } catch (err) {
      console.error("[notifications/queue] error processing message:", err);
      message.retry();
    }
  }
}

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: NotificationsEnv }>();

app.use("*", requestId);
app.use("*", async (c, next) => {
  validateEnv(c.env);
  await next();
});

// GET /notifications — in-app notifications for user
app.get("/notifications", async (c) => {
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";

  if (!userId || !tenantId) {
    throw badRequest("x-naelao-user-id and x-naelao-tenant-id headers are required");
  }

  const results = await c.env.PLATFORM_DB.prepare(
    `SELECT id, tenant_id, user_id, type, status, subject, created_at
     FROM notifications
     WHERE user_id = ? AND tenant_id = ? AND type = 'in_app'
     ORDER BY created_at DESC
     LIMIT 50`
  )
    .bind(userId, tenantId)
    .all<{
      id: string;
      tenant_id: string;
      user_id: string | null;
      type: string;
      status: string;
      subject: string | null;
      created_at: string;
    }>();

  return c.json({ notifications: results.results });
});

// PATCH /notifications/:id/read — mark notification as read
app.patch("/notifications/:id/read", async (c) => {
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const notifId = c.req.param("id");

  if (!userId || !tenantId) {
    throw badRequest("x-naelao-user-id and x-naelao-tenant-id headers are required");
  }

  const result = await c.env.PLATFORM_DB.prepare(
    `UPDATE notifications
     SET status = 'read'
     WHERE id = ? AND user_id = ? AND tenant_id = ?`
  )
    .bind(notifId, userId, tenantId)
    .run();

  if (result.meta.changes === 0) {
    throw notFound("Notification");
  }

  return c.json({ updated: true });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

// ── Export ────────────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,
  queue: queue as ExportedHandlerQueueHandler<NotificationsEnv>,
} satisfies ExportedHandler<NotificationsEnv>;
