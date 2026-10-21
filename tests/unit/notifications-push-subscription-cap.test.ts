import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import notificationsWorker from "../../workers/notifications/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0095_web_push_subscriptions.sql"), "utf8");
const SECRET = "push-cap-test-secret";
const execCtx = {} as ExecutionContext;
const fetchWorker = notificationsWorker.fetch;
if (!fetchWorker) throw new Error("notifications fetch handler missing");

describe("browser push subscription request bounds and per-user cap", () => {
  it("atomically caps concurrent unique subscriptions at 20 while allowing endpoint refresh", async () => {
    const db = createFakeD1([MIGRATION]);
    const env = {
      ENVIRONMENT: "test",
      RESEND_API_KEY: "resend",
      RESEND_API_URL: "https://resend.example.test",
      WEBHOOK_SIGNING_SECRET: "webhook-secret",
      PLATFORM_SECRET: SECRET,
      PLATFORM_DB: db,
    };
    const token = await mintInternalToken(SECRET, "tenant-a");
    const subscribe = async (index: number) => fetchWorker(new Request("https://notifications/internal/push/subscription", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-user-id": "user-a",
        "x-naelao-internal-token": token,
      },
      body: JSON.stringify({ subscription: {
        endpoint: `https://fcm.googleapis.com/fcm/send/token-${index}`,
        keys: { p256dh: `public-${index}`, auth: `auth-${index}` },
      } }),
    }), env as never, execCtx);

    const responses = await Promise.all(Array.from({ length: 21 }, (_, index) => subscribe(index)));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(20);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM web_push_subscriptions WHERE tenant_id='tenant-a' AND user_id='user-a'").get())
      .toEqual({ count: 20 });

    const refresh = await subscribe(0);
    expect(refresh.status).toBe(200);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM web_push_subscriptions WHERE tenant_id='tenant-a' AND user_id='user-a'").get())
      .toEqual({ count: 20 });
  });

  it("rejects oversized and malformed requests before writing subscription rows", async () => {
    const db = createFakeD1([MIGRATION]);
    const env = {
      ENVIRONMENT: "test",
      RESEND_API_KEY: "resend",
      RESEND_API_URL: "https://resend.example.test",
      WEBHOOK_SIGNING_SECRET: "webhook-secret",
      PLATFORM_SECRET: SECRET,
      PLATFORM_DB: db,
    };
    const token = await mintInternalToken(SECRET, "tenant-a");
    const headers = {
      "content-type": "application/json",
      "x-naelao-tenant-id": "tenant-a",
      "x-naelao-user-id": "user-a",
      "x-naelao-internal-token": token,
    };
    const oversized = await fetchWorker(new Request("https://notifications/internal/push/subscription", {
      method: "PUT", headers,
      body: JSON.stringify({ subscription: { endpoint: "x".repeat(17 * 1024) } }),
    }), env as never, execCtx);
    expect(oversized.status).toBe(413);
    const malformed = await fetchWorker(new Request("https://notifications/internal/push/subscription", {
      method: "PUT", headers, body: "{",
    }), env as never, execCtx);
    expect(malformed.status).toBe(400);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM web_push_subscriptions").get()).toEqual({ count: 0 });
  });
});
