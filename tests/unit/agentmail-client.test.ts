import { describe, it, expect, afterEach, vi } from "vitest";
import {
  agentMailConfigured,
  toInboxUsername,
  createInbox,
  createInboundWebhook,
  sendFromInbox,
  verifySvixSignature,
  parseInboundMessageReceived,
} from "../../workers/agents/src/channels/agentmail.js";

// AgentMail is an inbound-capable business mailbox whose domain AgentMail hosts (so no Naelao DNS
// zone is needed — the exact blocker the prior pass deferred on). This exercises the client
// against the REAL response shapes from AgentMail's OpenAPI (create-inbox → {email, inbox_id};
// send → {message_id, thread_id}; create-webhook → {webhook_id, secret}) plus a real Svix HMAC
// round-trip, and proves every function degrades honestly when the key is unset.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status, body } = handler(url, init ?? {});
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("agentmail client — honest degradation when unconfigured", () => {
  it("agentMailConfigured is false with no key; every op returns configured:false without calling out", async () => {
    const env = {};
    expect(agentMailConfigured(env)).toBe(false);
    let called = false;
    globalThis.fetch = vi.fn(async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;

    expect(await createInbox(env, { spaceId: "s1" })).toEqual({ ok: false, configured: false });
    expect(await createInboundWebhook(env, "inb_1", "https://x/y")).toEqual({ ok: false, configured: false });
    expect(await sendFromInbox(env, "inb_1", { to: "a@b.com" })).toEqual({ ok: false, configured: false });
    expect(called).toBe(false); // never touched the network without a key
  });
});

describe("toInboxUsername", () => {
  it("slugs to an AgentMail-safe local part", () => {
    expect(toInboxUsername("My Cool Shop!")).toBe("my-cool-shop");
    expect(toInboxUsername("")).toBe("team");
    expect(toInboxUsername("---weird--")).toBe("weird");
  });
});

describe("createInbox", () => {
  it("returns the real allocated email + inbox_id and sends client_id=spaceId", async () => {
    let sentBody: Record<string, unknown> = {};
    mockFetch((url, init) => {
      expect(url).toBe("https://api.agentmail.to/v0/inboxes");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer test-key");
      sentBody = JSON.parse(init.body as string);
      return { status: 200, body: { inbox_id: "inb_abc", email: "shop@agentmail.to", pod_id: "pod_1", created_at: "x", updated_at: "y" } };
    });
    const res = await createInbox({ AGENTMAIL_API_KEY: "test-key" }, { username: "shop", displayName: "My Shop", spaceId: "space-1" });
    expect(res).toMatchObject({ ok: true, configured: true, email: "shop@agentmail.to", inboxId: "inb_abc" });
    expect(sentBody).toEqual({ username: "shop", display_name: "My Shop", client_id: "space-1" });
  });

  it("fails gracefully on a non-2xx, carrying the upstream detail (truncated)", async () => {
    mockFetch(() => ({ status: 422, body: { message: "username taken" } }));
    const res = await createInbox({ AGENTMAIL_API_KEY: "k" }, { username: "taken", spaceId: "s" });
    expect(res.ok).toBe(false);
    expect(res.configured).toBe(true);
    expect(res.error).toContain("422");
  });

  it("treats a 200 missing email/inbox_id as a failure, never a half-provisioned success", async () => {
    mockFetch(() => ({ status: 200, body: { pod_id: "pod_1" } }));
    const res = await createInbox({ AGENTMAIL_API_KEY: "k" }, { spaceId: "s" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("missing email/inbox_id");
  });
});

describe("createInboundWebhook", () => {
  it("registers message.received and returns the Svix secret", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((url, init) => {
      expect(url).toBe("https://api.agentmail.to/v0/inboxes/inb_1/webhooks");
      body = JSON.parse(init.body as string);
      return { status: 200, body: { webhook_id: "wh_1", secret: "whsec_abc", enabled: true, url: "https://x/y", created_at: "a", updated_at: "b" } };
    });
    const res = await createInboundWebhook({ AGENTMAIL_API_KEY: "k" }, "inb_1", "https://x/y");
    expect(res).toMatchObject({ ok: true, webhookId: "wh_1", secret: "whsec_abc" });
    expect(body).toEqual({ url: "https://x/y", event_types: ["message.received"] });
  });
});

describe("sendFromInbox", () => {
  it("sends and returns message_id/thread_id", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((url, init) => {
      expect(url).toBe("https://api.agentmail.to/v0/inboxes/inb_1/messages/send");
      body = JSON.parse(init.body as string);
      return { status: 200, body: { message_id: "msg_1", thread_id: "thr_1" } };
    });
    const res = await sendFromInbox({ AGENTMAIL_API_KEY: "k" }, "inb_1", { to: "cust@x.com", subject: "Hi", text: "hello" });
    expect(res).toMatchObject({ ok: true, messageId: "msg_1", threadId: "thr_1" });
    expect(body).toEqual({ to: "cust@x.com", subject: "Hi", text: "hello" });
  });

  it("refuses an empty recipient rather than making a doomed call", async () => {
    let called = false;
    globalThis.fetch = vi.fn(async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    const res = await sendFromInbox({ AGENTMAIL_API_KEY: "k" }, "inb_1", { to: "", text: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("recipient");
    expect(called).toBe(false);
  });
});

describe("verifySvixSignature — real HMAC round-trip", () => {
  // Build a genuinely valid Svix signature the way Svix does, so this proves the verify logic,
  // not just that it accepts a hand-rolled string.
  async function signSvix(secret: string, id: string, timestamp: string, body: string): Promise<string> {
    const secretB64 = secret.slice("whsec_".length);
    const keyBytes = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
    let bin = "";
    const bytes = new Uint8Array(sig);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    return btoa(bin);
  }

  const secret = "whsec_" + btoa("super-secret-signing-key-32bytes!!");
  const body = JSON.stringify({ event_type: "message.received", message: { from: "a@b.com", text: "hi", message_id: "m1" } });

  it("accepts a correctly-signed, fresh delivery", async () => {
    const id = "msg_2abc";
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signSvix(secret, id, ts, body);
    const ok = await verifySvixSignature({
      headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` },
      rawBody: body, secret,
    });
    expect(ok).toBe(true);
  });

  it("accepts when the header carries multiple space-delimited signatures (secret rotation)", async () => {
    const id = "msg_3";
    const ts = String(Math.floor(Date.now() / 1000));
    const good = await signSvix(secret, id, ts, body);
    const ok = await verifySvixSignature({
      headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,deadbeef v1,${good}` },
      rawBody: body, secret,
    });
    expect(ok).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const id = "msg_4";
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signSvix(secret, id, ts, body);
    const ok = await verifySvixSignature({
      headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` },
      rawBody: body + "tampered", secret,
    });
    expect(ok).toBe(false);
  });

  it("rejects a stale (>5min) delivery, blocking replay", async () => {
    const id = "msg_5";
    const staleTs = String(Math.floor(Date.now() / 1000) - 600);
    const sig = await signSvix(secret, id, staleTs, body);
    const ok = await verifySvixSignature({
      headers: { "svix-id": id, "svix-timestamp": staleTs, "svix-signature": `v1,${sig}` },
      rawBody: body, secret,
    });
    expect(ok).toBe(false);
  });

  it("fails closed on missing headers or secret", async () => {
    expect(await verifySvixSignature({ headers: {}, rawBody: body, secret })).toBe(false);
    expect(await verifySvixSignature({ headers: { "svix-id": "x", "svix-timestamp": "1", "svix-signature": "v1,y" }, rawBody: body, secret: "" })).toBe(false);
  });
});

describe("parseInboundMessageReceived", () => {
  it("extracts from/text/message_id/subject from a real message.received event", () => {
    const parsed = parseInboundMessageReceived({
      type: "event", event_type: "message.received", event_id: "evt_1",
      message: { from: "Customer <cust@x.com>", to: ["shop@agentmail.to"], subject: "Order question", text: "where is my order?", message_id: "msg_9" },
      thread: { thread_id: "thr_9" },
    });
    expect(parsed).toEqual({ from: "Customer <cust@x.com>", text: "where is my order?", messageId: "msg_9", subject: "Order question" });
  });

  it("falls back to preview when text is absent", () => {
    const parsed = parseInboundMessageReceived({
      event_type: "message.received",
      message: { from: "a@b.com", preview: "short preview", message_id: "m2" },
    });
    expect(parsed?.text).toBe("short preview");
  });

  it("returns null for a spam-flagged variant — it must never auto-drive the agent", () => {
    expect(parseInboundMessageReceived({
      event_type: "message.received.spam",
      message: { from: "spammer@x.com", text: "buy now", message_id: "m3" },
    })).toBeNull();
  });

  it("returns null for a non-message event or an unusable message (ack-ignore, never 500)", () => {
    expect(parseInboundMessageReceived({ event_type: "message.sent", message: {} })).toBeNull();
    expect(parseInboundMessageReceived({ event_type: "message.received", message: { from: "a@b.com" } })).toBeNull();
    expect(parseInboundMessageReceived(null)).toBeNull();
    expect(parseInboundMessageReceived("nope")).toBeNull();
  });
});
