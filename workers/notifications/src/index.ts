// G-N01: Notifications worker — email + in-app notification consumer
import { badRequest, errorResponse, notFound, requestId, mintInternalToken } from "@naelao/http";
import { Hono } from "hono";

// ── Env ───────────────────────────────────────────────────────────────────────

export interface NotificationsEnv {
  ENVIRONMENT: string;
  RESEND_API_KEY: string;
  RESEND_API_URL: string;
  WEBHOOK_SIGNING_SECRET: string;
  PLATFORM_DB: D1Database;
  // G-P11/G-P12: APNs push notification credentials (optional — push disabled if absent)
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY_BASE64?: string;
  APNS_BUNDLE_ID?: string;
  APNS_HOST?: string; // "api.push.apple.com" prod, "api.sandbox.push.apple.com" sandbox
  /** Needed to resolve a space's own bot token / webhook URL for chat-channel replies. Optional:
   *  without it those channels degrade to delivered:false rather than crashing. */
  CREDENTIALS_WORKER?: Fetcher;
  PLATFORM_SECRET?: string;
  /**
   * Platform-app bot tokens, used when a business PAIRED a channel rather than bringing its own
   * app — there is no per-space credential in that case, because the connection belongs to
   * Naelao's app. Names match CHANNEL_SEND_CREDENTIAL so the lookup can fall through by key.
   */
  TELEGRAM_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  DISCORD_BOT_TOKEN?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
}

/** Per-channel credential name in the vault — the token this worker needs to SEND, which is a
 *  different secret from the one used to VERIFY inbound (see CHANNEL_SECRET_CREDENTIAL in the
 *  agents worker). Slack/Discord/Telegram all reply through a bot token or webhook URL the owner
 *  configures; nothing here is a platform-wide key. */
const CHANNEL_SEND_CREDENTIAL: Record<string, string> = {
  slack: "SLACK_BOT_TOKEN",
  discord: "DISCORD_BOT_TOKEN",
  telegram: "TELEGRAM_BOT_TOKEN",
  whatsapp: "WHATSAPP_ACCESS_TOKEN",
};

/**
 * Read a space's own channel credential out of the vault.
 *
 * Resolved at send time rather than cached: a rotated token has to take effect immediately, and a
 * reply is already a non-hot path. Returns null (never throws) so a missing credential degrades to
 * an honest delivered:false instead of failing the caller's whole run.
 */
async function resolveChannelCredential(
  env: NotificationsEnv,
  tenantId: string,
  spaceId: string,
  name: string
): Promise<string | null> {
  if (!env.CREDENTIALS_WORKER || !env.PLATFORM_SECRET || !spaceId) return null;
  try {
    const token = await mintInternalToken(env.PLATFORM_SECRET, tenantId);
    const resp = await env.CREDENTIALS_WORKER.fetch(new Request(
      `http://credentials-worker/v1/internal/spaces/${spaceId}/credentials/${encodeURIComponent(name)}/plaintext`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": tenantId,
          "x-naelao-internal-token": token,
        },
        body: "{}",
      }
    ));
    if (!resp.ok) return null;
    const { value } = await resp.json<{ value?: string }>();
    return value ?? null;
  } catch {
    return null;
  }
}

/** One reply, out to a chat channel. Returns why it didn't go rather than throwing. */
async function sendChatMessage(
  env: NotificationsEnv,
  opts: { channel: string; tenantId: string; spaceId: string; to: string; message: string }
): Promise<{ delivered: boolean; reason?: string; status?: number }> {
  const { channel, to, message } = opts;
  const credName = CHANNEL_SEND_CREDENTIAL[channel];
  if (!credName) return { delivered: false, reason: `no send path for channel '${channel}'` };
  if (!to) return { delivered: false, reason: "missing recipient" };

  // A business that PAIRED a channel (scanned a code against Naelao's own app) has no per-space
  // token of its own — the platform app owns the connection. Falling back to the platform token
  // is what makes a paired channel able to REPLY at all; without it, inbound would work and every
  // answer would silently go nowhere.
  const credential =
    (await resolveChannelCredential(env, opts.tenantId, opts.spaceId, credName)) ??
    (env as unknown as Record<string, string | undefined>)[credName] ??
    null;
  if (!credential) {
    return { delivered: false, reason: `${channel} is connected for receiving but has no ${credName} to reply with` };
  }

  try {
    let resp: Response;
    if (channel === "telegram") {
      // `to` is the chat id the message came from, not a username.
      resp = await fetch(`https://api.telegram.org/bot${credential}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: to, text: message }),
      });
    } else if (channel === "slack") {
      resp = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        body: JSON.stringify({ channel: to, text: message }),
      });
      // Slack answers 200 with ok:false for real failures (bad token, not in channel), so the
      // HTTP status alone would report a silent drop as a success.
      const payload = await resp.clone().json<{ ok?: boolean; error?: string }>()
        .catch(() => ({ ok: false }) as { ok?: boolean; error?: string });
      if (!payload.ok) return { delivered: false, reason: `slack: ${payload.error ?? "rejected"}`, status: resp.status };
    } else if (channel === "discord") {
      resp = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(to)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bot ${credential}` },
        body: JSON.stringify({ content: message }),
      });
    } else if (channel === "whatsapp") {
      // `to` is the customer's phone number; the credential is the Meta Cloud API access token,
      // and the phone-number id it posts through rides in the same vault entry as "<id>:<token>"
      // when the owner configured one — otherwise there is no route to send on.
      const [phoneNumberId, accessToken] = credential.includes(":")
        ? [credential.slice(0, credential.indexOf(":")), credential.slice(credential.indexOf(":") + 1)]
        : [null, credential];
      if (!phoneNumberId) {
        return { delivered: false, reason: "whatsapp needs WHATSAPP_ACCESS_TOKEN as '<phone_number_id>:<token>'" };
      }
      resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: message } }),
      });
    } else {
      return { delivered: false, reason: `no send path for channel '${channel}'` };
    }

    if (!resp.ok) return { delivered: false, reason: `${channel} returned ${resp.status}`, status: resp.status };
    return { delivered: true };
  } catch (err) {
    return { delivered: false, reason: `${channel} send failed: ${(err as Error).message}` };
  }
}

function validateEnv(env: NotificationsEnv): void {
  if (!env.RESEND_API_KEY) throw new Error("Missing required secret: RESEND_API_KEY");
  if (!env.WEBHOOK_SIGNING_SECRET) throw new Error("Missing required secret: WEBHOOK_SIGNING_SECRET");
}

// ── Queue message type ────────────────────────────────────────────────────────

interface NotificationMessage {
  type: "email" | "in_app" | "webhook" | "push";
  tenantId: string;
  userId?: string;
  spaceId?: string;
  email?: string;
  subject?: string;
  html?: string;
  templateId?: string;
  data?: Record<string, unknown>;
  webhookUrl?: string;
  // For push notifications
  title?: string;
  body?: string;
  deviceToken?: string; // explicit token (optional — can also look up via SpaceDO)
}

// ── G-P11: APNs JWT generation with correct DER→P1363 ECDSA conversion ──────
// Web Crypto returns DER-encoded ECDSA signatures. APNs requires raw P1363
// format: R || S (two 32-byte big-endian integers, 64 bytes total).

function derToP1363(derBuf: ArrayBuffer, coordSize = 32): Uint8Array {
  const der = new Uint8Array(derBuf);
  // DER SEQUENCE: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("APNs DER: expected SEQUENCE");
  // Skip length bytes (may be 1 or 2 bytes)
  const seqLenByte = der[offset++];
  if (seqLenByte === undefined) throw new Error("APNs DER: truncated");
  if (seqLenByte > 0x80) offset += seqLenByte & 0x7f; // long form length

  // Parse R INTEGER
  if (der[offset++] !== 0x02) throw new Error("APNs DER: expected INTEGER for R");
  const rLen = der[offset++] ?? 0;
  const rBytes = der.slice(offset, offset + rLen);
  offset += rLen;

  // Parse S INTEGER
  if (der[offset++] !== 0x02) throw new Error("APNs DER: expected INTEGER for S");
  const sLen = der[offset++] ?? 0;
  const sBytes = der.slice(offset, offset + sLen);

  // Strip leading 0x00 padding (added to indicate positive integer) and left-pad to coordSize
  const p1363 = new Uint8Array(coordSize * 2);
  const rTrimmed = rBytes[0] === 0x00 ? rBytes.slice(1) : rBytes;
  const sTrimmed = sBytes[0] === 0x00 ? sBytes.slice(1) : sBytes;
  p1363.set(rTrimmed, coordSize - rTrimmed.length);
  p1363.set(sTrimmed, coordSize * 2 - sTrimmed.length);
  return p1363;
}

function base64url(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateApnsJwt(env: NotificationsEnv): Promise<string> {
  // APNs JWT: header.payload signed with ES256 using APNS_PRIVATE_KEY (PEM/base64)
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID ?? "" })));
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ iss: env.APNS_TEAM_ID ?? "", iat: Math.floor(Date.now() / 1000) })));
  const signingInput = `${header}.${payload}`;

  // Import ECDSA P-256 key from base64-encoded raw PKCS8
  const keyBytes = Uint8Array.from(atob(env.APNS_PRIVATE_KEY_BASE64 ?? ""), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  // Sign and convert DER→P1363 (G-P11: the critical fix)
  const derSig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );
  const p1363Sig = derToP1363(derSig, 32); // 64 bytes total
  return `${signingInput}.${base64url(p1363Sig)}`;
}

// ── G-P12: sendPush with properly scoped env (no undefined spaceDO) ──────────
async function sendApnsPush(
  env: NotificationsEnv,
  deviceToken: string,
  title: string,
  body: string
): Promise<void> {
  const jwt = await generateApnsJwt(env);
  const payload = JSON.stringify({
    aps: { alert: { title, body }, sound: "default" },
  });

  const url = `https://${env.APNS_HOST}/3/device/${deviceToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": env.APNS_BUNDLE_ID ?? "",
      "content-type": "application/json",
    },
    body: payload,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`APNs push failed: ${res.status} ${errBody}`);
  }
}

// ── SSRF guard (G-AS03) ───────────────────────────────────────────────────────
// Prevents webhooks targeting internal CF infrastructure or RFC-1918 ranges.

const BLOCKED_HOSTNAME_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^169\.254\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^::1$/,
];

function validateWebhookUrl(rawUrl: string): { ok: boolean; message?: string } {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, message: "Invalid webhook URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, message: "Webhook URL must use http or https" };
  }
  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(u.hostname)) {
      return { ok: false, message: `Webhook URL hostname '${u.hostname}' is in a blocked range` };
    }
  }
  return { ok: true };
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

// ── Shared email send (used by both the async queue consumer and the synchronous
// /internal/notify HTTP route — same Resend call + same D1 audit row, one implementation). ──
async function sendEmailNow(
  env: NotificationsEnv,
  msg: Pick<NotificationMessage, "tenantId" | "userId" | "email" | "subject" | "html" | "templateId">
): Promise<{ ok: boolean; status?: number }> {
  let subject = msg.subject ?? "(no subject)";
  let html = msg.html ?? "";

  if (msg.templateId) {
    const tmpl = await loadEmailTemplate(env.PLATFORM_DB, msg.templateId, msg.tenantId);
    if (tmpl) {
      subject = tmpl.subject;
      html = tmpl.html;
    }
  }

  if (!msg.email) return { ok: false };

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

  if (!res.ok) return { ok: false, status: res.status };

  // Audit row in the `notifications` table (migration 0010: id, tenant_id, user_id NOT NULL,
  // type, title, body, ...) — this previously used columns (`status`, `subject`) that don't
  // exist on that schema and would have failed on every real insert, silently caught by this
  // function's own callers' try/catch. Only recorded when there's a platform user_id to
  // attribute it to (in-app notification list is per-user) — most email sends here go to an
  // external address with no platform user (e.g. a product end user's password reset), which
  // has nothing to attribute an in-app row to.
  if (msg.userId) {
    await env.PLATFORM_DB.prepare(
      `INSERT INTO notifications (id, tenant_id, user_id, type, title, body, created_at)
       VALUES (?, ?, ?, 'email', ?, ?, datetime('now'))`
    )
      .bind(crypto.randomUUID(), msg.tenantId, msg.userId, subject, html)
      .run();
  }

  return { ok: true };
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
          if (!msg.email) {
            console.warn("[notifications/queue] email message missing email address, acking");
            message.ack();
            break;
          }

          const result = await sendEmailNow(env, msg);
          if (!result.ok) {
            console.error(
              `[notifications/queue] Resend API error ${result.status ?? "unknown"} for email=${msg.email}`
            );
            message.retry();
            break;
          }

          message.ack();
          break;
        }

        case "in_app": {
          if (!msg.userId) {
            console.warn("[notifications/queue] in_app message missing userId, acking");
            message.ack();
            break;
          }
          await env.PLATFORM_DB.prepare(
            `INSERT INTO notifications (id, tenant_id, user_id, type, title, body, created_at)
             VALUES (?, ?, ?, 'in_app', ?, ?, datetime('now'))`
          )
            .bind(
              crypto.randomUUID(),
              msg.tenantId,
              msg.userId,
              msg.subject ?? "(no subject)",
              msg.data ? JSON.stringify(msg.data) : ""
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

          // G-AS03: SSRF guard — reject webhooks targeting internal/private ranges
          const ssrfCheck = validateWebhookUrl(msg.webhookUrl);
          if (!ssrfCheck.ok) {
            console.warn(`[notifications/queue] webhook blocked by SSRF guard: ${ssrfCheck.message} url=${msg.webhookUrl}`);
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

        case "push": {
          // G-P11/G-P12: APNs push notification with correct DER→P1363 signature
          if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY_BASE64 || !env.APNS_BUNDLE_ID) {
            console.warn("[notifications/queue] APNs not configured, skipping push notification");
            message.ack();
            break;
          }

          const deviceToken = msg.deviceToken;
          if (!deviceToken) {
            console.warn("[notifications/queue] push message missing deviceToken, acking");
            message.ack();
            break;
          }

          try {
            await sendApnsPush(
              env,
              deviceToken,
              msg.title ?? "Notification",
              msg.body ?? ""
            );
            message.ack();
          } catch (pushErr) {
            console.error("[notifications/queue] APNs push failed:", pushErr);
            message.retry();
          }
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

// POST /internal/notify — synchronous notification dispatch. Reachable only via service binding
// (workers_dev=false, same trust model as every other internal-only worker on this platform —
// see wrangler.toml). Every caller (NaelaoAgentDO's approval-request email, the `notifications`
// and `business-email` prebuilt scripts) already posts here; this route never existed, so those
// calls have always 404'd and been silently swallowed by the caller's own best-effort try/catch.
// Only "email" is wired synchronously for now (it's the one every caller actually needs today —
// approval notices and password reset both need this); slack/discord/whatsapp/apns/fcm still
// report `delivered: false` rather than pretending to work, matching the "unwired binding
// degrades honestly" precedent used everywhere else in this codebase.
app.post("/internal/notify", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{
    channel?: string;
    space_id?: string;
    to?: string;
    subject?: string;
    body?: string;
    html?: string;
    /** Chat channels carry their text here rather than in `body`. */
    message?: string;
  }>();

  if (body.channel === "email") {
    if (!body.to) throw badRequest("email notification requires 'to'");
    const result = await sendEmailNow(c.env, {
      tenantId,
      email: body.to,
      subject: body.subject ?? "(no subject)",
      html: body.html ?? body.body ?? "",
    });
    if (!result.ok) {
      return c.json({ delivered: false, channel: "email", status: result.status ?? null }, 502);
    }
    return c.json({ delivered: true, channel: "email" });
  }

  // Chat channels. Until now every one of these returned delivered:false unconditionally, which
  // meant a customer could message a business on Slack/Discord/WhatsApp, the agent would run and
  // produce a real answer, and the reply would never leave the building — the inbound half of
  // every channel worked and the outbound half did not exist.
  const chatChannel = String(body.channel ?? "");
  if (CHANNEL_SEND_CREDENTIAL[chatChannel]) {
    const result = await sendChatMessage(c.env, {
      channel: chatChannel,
      tenantId,
      spaceId: body.space_id ?? "",
      to: String(body.to ?? ""),
      message: String(body.message ?? body.body ?? ""),
    });
    return c.json(
      { delivered: result.delivered, channel: chatChannel, ...(result.reason ? { reason: result.reason } : {}) },
      result.delivered ? 200 : 502
    );
  }

  // Push (apns/fcm) still isn't wired synchronously. Honest failure, not a silent no-op — callers
  // already treat delivered:false as a real signal.
  return c.json({ delivered: false, channel: body.channel ?? "unknown", reason: "channel not wired for synchronous delivery" });
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
