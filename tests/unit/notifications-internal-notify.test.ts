import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import notificationsWorker from "../../workers/notifications/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Security audit follow-up: the notifications worker had a queue consumer but NO HTTP route at
// all. Every caller across the platform (NaelaoAgentDO's approval-request email, the
// `notifications` and `business-email` prebuilt scripts) POSTs to /internal/notify — a route
// that never existed, so every one of those calls has always 404'd and been silently swallowed
// by the caller's own best-effort try/catch. This exercises the route that now actually exists.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const NOTIFICATIONS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0010_notifications.sql"), "utf8");

function makeEnv(resendOk = true) {
  const fakeDb = createFakeD1([NOTIFICATIONS_MIGRATION]);
  return {
    ENVIRONMENT: "test",
    RESEND_API_KEY: "test-resend-key",
    RESEND_API_URL: "https://fake-resend.test",
    WEBHOOK_SIGNING_SECRET: "test-webhook-secret",
    PLATFORM_DB: fakeDb,
    __resendOk: resendOk,
  };
}

function req(body: unknown, tenantId = "tenant-1"): Request {
  return new Request("https://notifications.naelao.com/internal/notify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /internal/notify", () => {
  it("delivers an email via Resend and returns delivered:true", async () => {
    const env = makeEnv();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await notificationsWorker.fetch(
      req({ channel: "email", space_id: "space-1", to: "jane@acme.com", subject: "Hi", body: "hello" }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ delivered: true, channel: "email" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://fake-resend.test/emails",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("does not attribute an audit row when there's no platform user_id (external end-user email)", async () => {
    const env = makeEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    await notificationsWorker.fetch(
      req({ channel: "email", space_id: "space-1", to: "enduser@example.com", subject: "Reset your password", body: "token here" }),
      env as never, execCtx
    );
    const rows = await env.PLATFORM_DB.prepare("SELECT * FROM notifications").all();
    expect(rows.results).toHaveLength(0);
  });

  it("returns delivered:false (502) when the upstream Resend call fails, instead of a silent 404", async () => {
    const env = makeEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));

    const res = await notificationsWorker.fetch(
      req({ channel: "email", space_id: "space-1", to: "jane@acme.com", subject: "Hi", body: "hello" }),
      env as never, execCtx
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ delivered: false, channel: "email" });
  });

  it("reports a chat channel it cannot reply on honestly, naming the missing credential", async () => {
    // Slack/Discord/Telegram/WhatsApp DO have a real send path now (see
    // channel-outbound-delivery.test.ts). With no CREDENTIALS_WORKER bound there is no way to
    // resolve the space's bot token, so this must fail loudly rather than silently no-op.
    const env = makeEnv();
    const res = await notificationsWorker.fetch(
      req({ channel: "slack", space_id: "space-1", channel_name: "#general", message: "hi" }),
      env as never, execCtx
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ delivered: false, channel: "slack" });
  });

  it("still reports honestly for push channels, which have no synchronous path at all", async () => {
    const env = makeEnv();
    const res = await notificationsWorker.fetch(
      req({ channel: "fcm", space_id: "space-1", token: "t", payload: {} }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ delivered: false, channel: "fcm" });
  });

  it("400s when an email notification has no 'to' address", async () => {
    const env = makeEnv();
    const res = await notificationsWorker.fetch(
      req({ channel: "email", space_id: "space-1", subject: "Hi", body: "hello" }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });
});
