import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type NotificationsEnv } from "./index.js";
function env(): NotificationsEnv {
  return { ENVIRONMENT: "test", RESEND_API_KEY: "resend", RESEND_API_URL: "https://api.resend.test", WEBHOOK_SIGNING_SECRET: "secret",
    TELEGRAM_BOT_TOKEN: "telegram-test", WHATSAPP_ACCESS_TOKEN: "123456789012345:meta-test",
    PLATFORM_DB: { prepare: (sql: string) => ({ bind: () => ({ first: async () => sql.includes("FROM orgs") ? { status: "active" } : { config_json: "{}" } }) }) } as unknown as D1Database,
  };
}
describe("interactive mobile approval delivery", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("rejects oversized and malformed synchronous notify payloads before provider egress", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const fetchWorker = worker.fetch;
    if (!fetchWorker) throw new Error("notifications fetch handler missing");
    const oversized = await fetchWorker(new Request("https://notifications/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" },
      body: JSON.stringify({ channel: "email", to: "customer@example.net", body: "x".repeat(270 * 1024) }),
    }), env(), {} as ExecutionContext);
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error_code: "request_body_too_large" });

    const malformed = await fetchWorker(new Request("https://notifications/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" },
      body: "{",
    }), env(), {} as ExecutionContext);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error_code: "invalid_request_body" });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("blocks synchronous delivery for suspended tenants", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch!(new Request("https://notifications/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" },
      body: JSON.stringify({ channel: "email", to: "customer@example.net", body: "Hello" }),
    }), {
      ...env(),
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ status: "suspended" }) }) }) } as unknown as D1Database,
    }, {} as ExecutionContext);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ delivered: false, reason: "tenant_suspended" });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("blocks outbound delivery when the supplied Space is inactive or belongs to another tenant", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const db = { prepare: (sql: string) => ({ bind: () => ({ first: async () => {
      if (sql.includes("SELECT s.id FROM spaces")) return null;
      return sql.includes("FROM orgs") ? { status: "active" } : null;
    } }) }) } as unknown as D1Database;
    const response = await worker.fetch!(new Request("https://notifications/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" },
      body: JSON.stringify({ channel: "email", space_id: "space", to: "customer@example.net", body: "Hello" }),
    }), { ...env(), PLATFORM_DB: db }, {} as ExecutionContext);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ delivered: false, reason: "space_inactive" });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("reports the sender actually configured on the outbound Resend request", async () => {
    const outbound = vi.fn(async () => Response.json({ id: "email-1" }));
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch!(new Request("https://notifications/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" },
      body: JSON.stringify({ channel: "email", space_id: "space", to: "customer@example.net", subject: "Hello", body: "World", reply_to: "reply-a1@example.test" }),
    }), { ...env(), RESEND_FROM_ADDRESS: "team@example.org" }, {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivered: true, channel: "email", from: "team@example.org" });
    const payload = JSON.parse((outbound.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(payload.from).toBe("team@example.org");
    expect(payload.reply_to).toBe("reply-a1@example.test");
  });

  for (const channel of ["telegram", "whatsapp"]) it(`sends provider-format review buttons for ${channel}`, async () => {
    const outbound = vi.fn(async () => Response.json({ ok: true })); vi.stubGlobal("fetch", outbound);
    const res = await worker.fetch!(new Request("https://notifications/internal/notify", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" }, body: JSON.stringify({ channel, space_id: "space", to: "1", body: "Urgent approval", actions: [{ id: "review:approval-1", label: "Review approval" }] }) }), env(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const payload = JSON.parse((outbound.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    if (channel === "telegram") expect(payload.reply_markup.inline_keyboard).toEqual([[{ text: "Review approval", callback_data: "review:approval-1" }]]);
    else expect(payload).toMatchObject({ type: "interactive", interactive: { type: "button", action: { buttons: [{ reply: { id: "review:approval-1" } }] } } });
  });
  it("reports provider rejection instead of claiming delivery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Rejected", { status: 400 })));
    const res = await worker.fetch!(new Request("https://notifications/internal/notify", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" }, body: JSON.stringify({ channel: "whatsapp", space_id: "space", to: "1", message: "Escalation" }) }), env(), {} as ExecutionContext);
    expect(res.status).toBe(502); expect(await res.json()).toMatchObject({ delivered: false });
  });

  it("uses an explicitly selected per-Space Meta direct transport even when platform Twilio is configured", async () => {
    const outbound = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ messages: [{ id: "wamid.1" }] }));
    vi.stubGlobal("fetch", outbound);
    const credentials = {
      async fetch(request: Request) {
        const name = new URL(request.url).pathname.split("/").at(-2);
        const value = name === "WHATSAPP_TRANSPORT" ? "meta"
          : name === "WHATSAPP_PHONE_NUMBER_ID" ? "123456789012345"
          : name === "WHATSAPP_ACCESS_TOKEN" ? "space-meta-token" : null;
        return value ? Response.json({ value }) : new Response("missing", { status: 404 });
      },
    };
    const response = await worker.fetch!(new Request("https://notifications/internal/notify", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" },
      body: JSON.stringify({ channel: "whatsapp", space_id: "space", to: "+15551234567", message: "Hello" }),
    }), {
      ...env(), PLATFORM_SECRET: "platform-secret", CREDENTIALS_WORKER: credentials as unknown as Fetcher,
      TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "twilio-token", TWILIO_WHATSAPP_NUMBER: "+15550000000",
    }, {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivered: true });
    expect(outbound).toHaveBeenCalledOnce();
    expect(outbound.mock.calls[0]?.[0]).toBe("https://graph.facebook.com/v26.0/123456789012345/messages");
    expect(new Headers(outbound.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer space-meta-token");
  });

  it("marks an installation-scoped Slack credential for reconnect after provider revocation", async () => {
    const updates: Array<{ sql: string; args: unknown[] }> = [];
    const db = { prepare(sql: string) { return { bind(...args: unknown[]) { return {
      async first() { return sql.includes("FROM orgs") ? { status: "active" } : { credential_name: "EXT_SLACK_install_conn_generation" }; },
      async run() { updates.push({ sql, args }); return { success: true }; },
    }; } }; } };
    const credentials = { async fetch() { return Response.json({ value: "xoxb-install-token" }); } };
    const outbound = vi.fn(async () => Response.json({ ok: false, error: "token_revoked" })); vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch!(new Request("https://notifications/internal/notify", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" },
      body: JSON.stringify({ channel: "slack", space_id: "space", to: "D123", message: "Reply", installation_id: "install", provider_connection_id: "slack-main" }) }),
      { ...env(), PLATFORM_DB: db as unknown as D1Database, PLATFORM_SECRET: "platform-secret", CREDENTIALS_WORKER: credentials as unknown as Fetcher }, {} as ExecutionContext);
    expect(response.status).toBe(502);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql).toContain("status='error'");
    expect(updates[0]?.args).toContain("install");
    expect(outbound).toHaveBeenCalledOnce();
  });

  it("sends WhatsApp extension replies with that installation's phone-number ID and token", async () => {
    const updates: Array<{ sql: string; args: unknown[] }> = [];
    const db = { prepare(sql: string) { return { bind(...args: unknown[]) { return {
      async first() {
        if (sql.includes("FROM orgs")) return { status: "active" };
        if (sql.includes("SELECT credential_name")) return { credential_name: "EXT_WHATSAPP_install_connection_generation" };
        if (sql.includes("SELECT account_id")) return { account_id: "987654321012345" };
        return { config_json: "{}" };
      },
      async run() { updates.push({ sql, args }); return { success: true }; },
    }; } }; } };
    const credentials = { async fetch(request: Request) {
      expect(new URL(request.url).pathname).toContain("EXT_WHATSAPP_install_connection_generation");
      return Response.json({ value: "installation-meta-token" });
    } };
    const outbound = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ messages: [{ id: "wamid.1" }] })); vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch!(new Request("https://notifications/internal/notify", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" },
      body: JSON.stringify({ channel: "whatsapp", space_id: "space", to: "+15551234567", message: "Reply", installation_id: "install", provider_connection_id: "wa-main" }) }),
      { ...env(), PLATFORM_DB: db as unknown as D1Database, PLATFORM_SECRET: "platform-secret", CREDENTIALS_WORKER: credentials as unknown as Fetcher }, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivered: true });
    expect(outbound).toHaveBeenCalledOnce();
    expect(outbound.mock.calls[0]?.[0]).toBe("https://graph.facebook.com/v26.0/987654321012345/messages");
    expect(new Headers(outbound.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer installation-meta-token");
    expect(JSON.parse(outbound.mock.calls[0]?.[1]?.body as string)).toMatchObject({ messaging_product: "whatsapp", to: "+15551234567" });
  });
});
