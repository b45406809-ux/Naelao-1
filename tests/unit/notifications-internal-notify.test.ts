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
  const fakeDb = createFakeD1([NOTIFICATIONS_MIGRATION, `CREATE TABLE spaces (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', config_json TEXT NOT NULL DEFAULT '{}');`]);
  fakeDb.db.exec(`INSERT INTO spaces (id, status, config_json) VALUES ('space-1', 'active', '{}')`);
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

  it("converts a plain-text body's line breaks to <br> before sending to Resend, instead of one unbroken run-on paragraph", async () => {
    // Live-reported bug (verify-email link "not arriving"): Resend's own delivery tracking showed
    // every send was accepted and delivered — the real defect was downstream, every plain-text
    // caller (verify-email, reset-password, approval notices) hands its message in as `html` with
    // literal \n\n line breaks, which HTML renders as nothing at all.
    const env = makeEnv();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: "email-2" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await notificationsWorker.fetch(
      req({
        channel: "email",
        space_id: "space-1",
        to: "jane@acme.com",
        subject: "Verify your email",
        body: "Verification token: abc123\n\nOr click this link: https://app.example.com/verify?token=abc123\n\nThis token expires in 24 hours.",
      }),
      env as never, execCtx
    );

    const sentBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(sentBody.html).not.toContain("\n");
    expect(sentBody.html).toBe(
      "Verification token: abc123<br><br>Or click this link: https://app.example.com/verify?token=abc123<br><br>This token expires in 24 hours."
    );
  });

  it("leaves an already-HTML body untouched (a real template, not plain text)", async () => {
    const env = makeEnv();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: "email-3" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const realHtml = "<p>Hello</p>\n<p>World</p>";
    await notificationsWorker.fetch(
      req({ channel: "email", space_id: "space-1", to: "jane@acme.com", subject: "Hi", html: realHtml }),
      env as never, execCtx
    );

    const sentBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(sentBody.html).toBe(realHtml);
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
