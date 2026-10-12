import { describe, it, expect, vi, afterEach } from "vitest";
import notificationsWorker from "../../workers/notifications/src/index.js";
import { getAdapter, isChannelType } from "../../workers/agents/src/launchpad/channels.js";

// Replying to a customer on a chat channel.
//
// This half did not exist. `/internal/notify` handled email and returned delivered:false for every
// other channel unconditionally — so a customer could message a business on Slack, Discord or
// WhatsApp, the agent would run and produce a real answer, and the reply would never leave the
// building. The inbound half of every channel worked; the outbound half was a stub.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeEnv(opts: { credential?: string | null } = {}) {
  return {
    ENVIRONMENT: "test",
    RESEND_API_KEY: "re_test",
    RESEND_API_URL: "https://api.resend.com/emails",
    WEBHOOK_SIGNING_SECRET: "whsec",
    PLATFORM_SECRET: "platform-secret",
    // Network delivery is fail-closed when policy is absent. These tests exercise provider
    // formatting, so use a real row with an explicit non-air-gapped policy.
    PLATFORM_DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => ({ config_json: "{}" }) }) }) },
    CREDENTIALS_WORKER: {
      fetch: async () =>
        opts.credential === null
          ? new Response("{}", { status: 404 })
          : new Response(JSON.stringify({ value: opts.credential ?? "bot-token-123" }), { status: 200 }),
    },
  } as never;
}

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function notify(env: unknown, body: Record<string, unknown>) {
  return notificationsWorker.fetch(
    new Request("http://notifications/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1" },
      body: JSON.stringify(body),
    }),
    env as never,
    execCtx
  );
}

describe("chat-channel replies", () => {
  it("sends a Telegram reply to the chat it came from", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as never;

    const res = await notify(makeEnv(), { channel: "telegram", space_id: "space-1", to: "-100123", message: "on its way" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ delivered: true, channel: "telegram" });

    expect(calls[0]!.url).toContain("api.telegram.org/botbot-token-123/sendMessage");
    // chat_id, not a username — a group reply has to go to the conversation, not the sender.
    expect(calls[0]!.body).toMatchObject({ chat_id: "-100123", text: "on its way" });
  });

  it("treats Slack's 200-with-ok:false as a failure, not a delivery", async () => {
    // Slack answers 200 for a bad token or a channel the bot isn't in. Trusting the HTTP status
    // would report a silently dropped reply as delivered.
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 })
    ) as never;

    const res = await notify(makeEnv(), { channel: "slack", space_id: "space-1", to: "C123", message: "hi" });
    expect(res.status).toBe(502);
    const body = await res.json<{ delivered: boolean; reason: string }>();
    expect(body.delivered).toBe(false);
    expect(body.reason).toContain("not_in_channel");
  });

  it("says a channel can receive but not reply when the send token is missing", async () => {
    // The exact state an owner lands in after connecting for inbound only. A bare "failed" would
    // send them looking in the wrong place.
    const res = await notify(makeEnv({ credential: null }), {
      channel: "telegram", space_id: "space-1", to: "42", message: "hi",
    });
    expect(res.status).toBe(502);
    const body = await res.json<{ reason: string }>();
    expect(body.reason).toContain("TELEGRAM_BOT_TOKEN");
    expect(body.reason).toContain("connected for receiving");
  });

  it("refuses WhatsApp without the phone-number id it has to post through", async () => {
    const res = await notify(makeEnv({ credential: "just-a-token" }), {
      channel: "whatsapp", space_id: "space-1", to: "+15551234", message: "hi",
    });
    const body = await res.json<{ delivered: boolean; reason: string }>();
    expect(body.delivered).toBe(false);
    expect(body.reason).toContain("phone_number_id");
  });

  it("still reports honestly for a channel with no send path at all", async () => {
    const res = await notify(makeEnv(), { channel: "fcm", space_id: "space-1", to: "x", message: "y" });
    expect((await res.json<{ delivered: boolean }>()).delivered).toBe(false);
  });
});

describe("telegram adapter", () => {
  const adapter = getAdapter("telegram")!;

  it("is a real channel type", () => {
    expect(isChannelType("telegram")).toBe(true);
    expect(adapter).toBeDefined();
  });

  it("keys on the chat, not the sender, so a group reply goes to the right place", () => {
    const norm = adapter.normalizeInbound({
      message: { message_id: 7, date: 1700000000, text: "hello", from: { id: 999 }, chat: { id: -100555 } },
    });
    expect(norm!.channel_user_id).toBe("-100555");
    // message_id is only unique per chat, so the dedupe key has to carry both.
    expect(norm!.external_id).toBe("-100555:7");
    expect(norm!.timestamp).toBe(1700000000 * 1000);
  });

  it("ignores updates that aren't actionable messages", () => {
    expect(adapter.normalizeInbound({ edited_message: { text: "oops" } })).toBeNull();
    expect(adapter.normalizeInbound({ message: { chat: { id: 1 }, text: "   " } })).toBeNull();
    expect(adapter.normalizeInbound({ message: { text: "hi" } })).toBeNull(); // no chat or sender
    expect(adapter.normalizeInbound({ callback_query: { id: "x" } })).toBeNull();
  });

  it("verifies the secret token Telegram echoes back, and fails closed without it", async () => {
    // Telegram does not sign payloads — this is a shared bearer secret, compared in constant time.
    const secret = "s3cret-token";
    expect(await adapter.verifySignature({
      rawBody: "{}", headers: { "x-telegram-bot-api-secret-token": secret }, secret,
    })).toBe(true);

    expect(await adapter.verifySignature({
      rawBody: "{}", headers: { "x-telegram-bot-api-secret-token": "wrong" }, secret,
    })).toBe(false);

    // A missing header must never pass — that would make the webhook world-writable.
    expect(await adapter.verifySignature({ rawBody: "{}", headers: {}, secret })).toBe(false);
    // And no configured secret is not an invitation either.
    expect(await adapter.verifySignature({
      rawBody: "{}", headers: { "x-telegram-bot-api-secret-token": "anything" }, secret: "",
    })).toBe(false);
  });
});
