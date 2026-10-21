import { describe, it, expect, vi } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { createAgentEmailAddress, createReplyAddress, hashEmailAddress } from "../../workers/agents/src/channels/cloudflare-email.js";
import { handleCloudflareEmail } from "../../workers/agents/src/index.js";

// AgentMail wiring on the agents worker: the /internal/business-email/{provision,send} routes hold
// AGENTMAIL_API_KEY (the isolate never sees it) and the public /channels/email/agentmail-inbound
// route Svix-verifies. These prove the HMAC gate, honest degradation when the key is unset, and
// that the inbound route fails closed on a bad signature — WITHOUT needing a live AgentMail key.

const SECRET = "test-platform-secret";
const TENANT = "tenant-1";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(over: Partial<AgentsEnv> = {}): AgentsEnv {
  return {
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ tenant_id: TENANT, status: "active" }) }) }),
    },
    ...over,
  } as unknown as AgentsEnv;
}

async function post(path: string, body: unknown, env: AgentsEnv, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(
    new Request(`https://agents.naelao.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env as never,
    execCtx
  );
}

async function expectedCloudflareAddress(tenantId: string, spaceId: string, domain: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${tenantId}\0${spaceId}`));
  const localPart = [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `space-${localPart}@${domain}`;
}

describe("/internal/business-email/provision", () => {
  it("rejects a request with no internal token (403)", async () => {
    const res = await post("/internal/business-email/provision", { spaceId: "s1", tenantId: TENANT }, makeEnv(), { "x-naelao-tenant-id": TENANT });
    expect(res.status).toBe(403);
  });

  it("rejects a tenant that doesn't match the token (403)", async () => {
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/provision", { spaceId: "s1", tenantId: "other-tenant" }, makeEnv(),
      { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    expect(res.status).toBe(403);
  });

  it("degrades honestly (configured:false) when AGENTMAIL_API_KEY is unset", async () => {
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/provision", { spaceId: "s1", tenantId: TENANT }, makeEnv(),
      { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; configured: boolean };
    expect(body).toMatchObject({ ok: false, configured: false });
  });

  it("returns a stable send-only Cloudflare address when Email Service is configured", async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const env = makeEnv({
      EMAIL_SENDING_DOMAIN: "mail.example.com",
      EMAIL: { send: async () => ({ messageId: "unused" }) } as never,
      SPACES_WORKER: {
        fetch: async (request: Request) => {
          persisted.push(await request.json() as Record<string, unknown>);
          return Response.json({ ok: true });
        },
      } as unknown as Fetcher,
    });
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/provision", { spaceId: "s1", tenantId: TENANT }, env,
      { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    const address = await expectedCloudflareAddress(TENANT, "s1", "mail.example.com");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, configured: true, provider: "cloudflare_email", email: address, inbound_wired: false });
    expect(persisted).toEqual([{ space_id: "s1", kind: "business_email", handle: address }]);
  });

  it("provisions a per-agent Cloudflare Email Routing address without AgentMail", async () => {
    const writes: Array<{ query: string; values: unknown[] }> = [];
    const env = makeEnv({
      EMAIL_INGRESS_DOMAIN: "agents.example.test",
      PLATFORM_DB: { prepare: (query: string) => ({ bind: (...values: unknown[]) => ({
        first: async () => query.includes("FROM spaces") ? { id: "s1", status: "active", config_json: "{}" } : null,
        run: async () => { writes.push({ query, values }); return { success: true }; },
      }) }) } as never,
    });
    const token = await mintInternalToken(SECRET, TENANT);
    const response = await post("/internal/business-email/provision", { spaceId: "s1", tenantId: TENANT, agentId: "agent-a" }, env,
      { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    const address = await createAgentEmailAddress({ domain: "agents.example.test", tenantId: TENANT, spaceId: "s1", agentId: "agent-a", secret: SECRET });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, configured: true, provider: "cloudflare_email_routing", email: address, inbound_wired: true });
    expect(writes[0]?.query).toContain("INSERT INTO agent_email_addresses");
    expect(writes[0]?.values).toEqual([await hashEmailAddress(address), TENANT, "s1", "agent-a", expect.any(String)]);
  });
});

describe("/internal/business-email/send", () => {
  it("creates a stable run-scoped reply address only when ingress is configured", async () => {
    const env = makeEnv({
      EMAIL_INGRESS_DOMAIN: "agents.example.test",
      PLATFORM_DB: {
        prepare: (query: string) => ({ bind: () => ({
          first: async () => {
            if (query.includes("SELECT id FROM spaces")) return { id: "s1" };
            if (query.includes("SELECT address_hash")) return null;
            if (query.includes("COUNT(*)")) return { count: 0 };
            return null;
          },
          run: async () => ({ success: true }),
        }) }),
      } as never,
    });
    const token = await mintInternalToken(SECRET, TENANT);
    const response = await post("/internal/business-email/reply-address", {
      tenantId: TENANT, spaceId: "s1", taskId: "run-1", agentId: "naelao-agent",
    }, env, { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    const body = await response.json() as { address: string };
    expect(response.status).toBe(200);
    expect(body.address).toBe(await createReplyAddress({ domain: "agents.example.test", tenantId: TENANT, spaceId: "s1", taskId: "run-1", secret: SECRET }));
  });

  it("does not send task-correlated mail unless Reply-To belongs to the current task", async () => {
    const replyTo = await createReplyAddress({ domain: "agents.example.test", tenantId: TENANT, spaceId: "s1", taskId: "run-1", secret: SECRET });
    const replyHash = await hashEmailAddress(replyTo);
    const sent: Request[] = [];
    const env = makeEnv({
      EMAIL_INGRESS_DOMAIN: "agents.example.test",
      PLATFORM_DB: {
        prepare: (query: string) => ({ bind: () => ({ first: async () => query.includes("email_reply_routes")
          ? { address_hash: replyHash }
          : query.includes("SELECT s.id FROM spaces") ? { id: "s1" }
          : query.includes("config_json") ? { config_json: "{}" } : null }) }),
      } as never,
      NOTIFICATIONS_WORKER: { fetch: async (request: Request) => { sent.push(request); return Response.json({ delivered: true, from: "team@example.test" }); } } as unknown as Fetcher,
    });
    const token = await mintInternalToken(SECRET, TENANT);
    const response = await post("/internal/business-email/send", {
      spaceId: "s1", tenantId: TENANT, taskId: "run-1", replyTo, to: "vendor@example.net", subject: "Invoice", text: "Please reply",
    }, env, { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, provider: "resend", reply_to: replyTo });
    expect(await sent[0]!.json()).toMatchObject({ channel: "email", reply_to: replyTo, to: "vendor@example.net" });
  });

  it("degrades honestly (configured:false) when AGENTMAIL_API_KEY is unset — so the prebuilt falls back to Resend", async () => {
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/send", { spaceId: "s1", tenantId: TENANT, to: "a@b.com" }, makeEnv(),
      { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; configured: boolean };
    expect(body).toMatchObject({ ok: false, configured: false });
  });

  it("400s when `to` is missing", async () => {
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/send", { spaceId: "s1", tenantId: TENANT }, makeEnv(),
      { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    expect(res.status).toBe(400);
  });

  it("uses the Cloudflare Email Service binding only with the configured sender domain", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const env = makeEnv({
      EMAIL_SENDING_DOMAIN: "Mail.Example.COM.",
      EMAIL: { send: async (message: Record<string, unknown>) => { sent.push(message); return { messageId: "cf-message-1" }; } } as never,
    });
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/send", {
      spaceId: "s1", tenantId: TENANT, to: "customer@example.net", subject: "Hello", text: "Body",
    }, env, { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, configured: true, provider: "cloudflare_email", messageId: "cf-message-1" });
    expect(sent).toEqual([{
      from: await expectedCloudflareAddress(TENANT, "s1", "mail.example.com"),
      to: "customer@example.net", subject: "Hello", text: "Body",
    }]);
  });

  it("does not use the Cloudflare binding with a malformed sender domain", async () => {
    let called = false;
    const env = makeEnv({
      EMAIL_SENDING_DOMAIN: "example.com.attacker.invalid;to=",
      EMAIL: { send: async () => { called = true; return { messageId: "should-not-send" }; } } as never,
    });
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/send", {
      spaceId: "s1", tenantId: TENANT, to: "customer@example.net",
    }, env, { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, configured: false, reason: "no_outbound_email_provider" });
    expect(called).toBe(false);
  });

  it("blocks Cloudflare email sends for air-gapped Spaces before calling the binding", async () => {
    let called = false;
    const env = makeEnv({
      EMAIL_SENDING_DOMAIN: "mail.example.com",
      EMAIL: { send: async () => { called = true; return { messageId: "should-not-send" }; } } as never,
      PLATFORM_DB: {
        prepare: () => ({ bind: () => ({ first: async () => ({ config_json: '{"compliance":{"airGappedOnly":true}}' }) }) }),
      } as never,
    });
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/send", {
      spaceId: "s1", tenantId: TENANT, to: "customer@example.net",
    }, env, { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error_code: "air_gap_egress_denied" });
    expect(called).toBe(false);
  });

  it("blocks all provider sends when the Space or organization is inactive", async () => {
    const send = vi.fn(async () => ({ messageId: "should-not-send" }));
    const env = makeEnv({
      EMAIL_SENDING_DOMAIN: "mail.example.com",
      EMAIL: { send } as never,
      AGENTMAIL_API_KEY: "agentmail-key",
      PLATFORM_DB: {
        prepare: () => ({ bind: () => ({ first: async () => null }) }),
      } as never,
    });
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/send", {
      spaceId: "s1", tenantId: TENANT, to: "customer@example.net",
    }, env, { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error_code: "tenant_suspended" });
    expect(send).not.toHaveBeenCalled();
  });

  it("blocks task-correlated reply email in air-gapped Spaces before calling notifications", async () => {
    const replyTo = await createReplyAddress({ domain: "agents.example.test", tenantId: TENANT, spaceId: "s1", taskId: "run-1", secret: SECRET });
    let called = false;
    const env = makeEnv({
      EMAIL_INGRESS_DOMAIN: "agents.example.test",
      NOTIFICATIONS_WORKER: { fetch: async () => { called = true; return Response.json({ delivered: true }); } } as unknown as Fetcher,
      PLATFORM_DB: {
        prepare: () => ({ bind: () => ({ first: async () => ({ config_json: '{"compliance":{"airGappedOnly":true}}' }) }) }),
      } as never,
    });
    const token = await mintInternalToken(SECRET, TENANT);
    const response = await post("/internal/business-email/send", {
      spaceId: "s1", tenantId: TENANT, taskId: "run-1", replyTo, to: "vendor@example.net", text: "Reply",
    }, env, { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "air_gap_egress_denied" });
    expect(called).toBe(false);
  });
});

describe("/internal/business-email/attachment/read-text", () => {
  it("reads a small text attachment by opaque id only after tenant, Space and task authorization", async () => {
    const id = "attachment-1";
    const key = "spaces/s1/email-inbound/run-1/hash/0-note.txt";
    const get = vi.fn(async () => ({ size: 11, httpMetadata: { contentType: "text/plain" }, arrayBuffer: async () => new TextEncoder().encode("hello world").buffer }));
    const env = makeEnv({
      PLATFORM_DB: { prepare: (query: string) => ({ bind: (...values: unknown[]) => ({ first: async () => query.includes("channel_attachments") && values[0] === id && values[1] === TENANT && values[2] === "s1" && values[3] === "run-1" ? { id, object_key: key, filename: "note.txt", mime_type: "text/plain" } : null }) }) } as never,
      SCRIPTS_R2: { get } as never,
    });
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/attachment/read-text", { tenantId: TENANT, spaceId: "s1", taskId: "run-1", id }, env,
      { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result).toMatchObject({ attachment_id: id, mime_type: "text/plain", text: expect.stringContaining("UNTRUSTED EMAIL ATTACHMENT") });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(get).toHaveBeenCalledWith(key);
  });

  it("does not read an attachment registered to another task", async () => {
    const get = vi.fn();
    const env = makeEnv({
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as never,
      SCRIPTS_R2: { get } as never,
    });
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/attachment/read-text", { tenantId: TENANT, spaceId: "s1", taskId: "run-other", key: "spaces/s1/email-inbound/run-1/hash/0-note.txt" }, env,
      { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    expect(res.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects unsupported binary attachments without returning their bytes", async () => {
    const id = "attachment-image";
    const key = "spaces/s1/email-inbound/run-1/hash/0-file.png";
    const env = makeEnv({
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id, object_key: key, filename: "image.png", mime_type: "image/png" }) }) }) } as never,
      SCRIPTS_R2: { get: async () => ({ size: 5, httpMetadata: { contentType: "image/png" }, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer }) } as never,
    });
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/attachment/read-text", { tenantId: TENANT, spaceId: "s1", taskId: "run-1", id }, env,
      { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error_code: "attachment_not_text" });
  });
});

describe("/channels/email/agentmail-inbound/:spaceId", () => {
  it("400s when no vaulted webhook secret exists (inbound not configured for this space)", async () => {
    // CREDENTIALS_WORKER returns non-OK for the secret lookup → no_webhook_secret.
    const env = makeEnv({
      CREDENTIALS_WORKER: { fetch: async () => new Response("not found", { status: 404 }) } as unknown as Fetcher,
    });
    const res = await post("/channels/email/agentmail-inbound/s1", { event_type: "message.received" }, env,
      { "svix-id": "x", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,deadbeef" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error_code: string };
    expect(body.error_code).toBe("no_webhook_secret");
  });

  it("401s on an invalid Svix signature even when a secret exists (fails closed)", async () => {
    const env = makeEnv({
      CREDENTIALS_WORKER: { fetch: async () => Response.json({ value: "whsec_" + btoa("k".repeat(24)) }) } as unknown as Fetcher,
    });
    const res = await post("/channels/email/agentmail-inbound/s1", { event_type: "message.received" }, env,
      { "svix-id": "x", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,not-a-real-signature" });
    expect(res.status).toBe(401);
  });
});

describe("Cloudflare task reply email handler", () => {
  it("rejects unknown aliases before parsing or dispatching email", async () => {
    const setReject = vi.fn();
    const env = makeEnv({
      EMAIL_INGRESS_DOMAIN: "agents.example.test",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as never,
    });
    await handleCloudflareEmail({
      from: "vendor@example.net", to: "unknown@agents.example.test", rawSize: 20,
      raw: new ReadableStream<Uint8Array>(), headers: new Headers(), setReject,
      forward: async () => ({} as never), reply: async () => ({} as never),
    } as ForwardableEmailMessage, env);
    expect(setReject).toHaveBeenCalledWith("Unknown or expired Naelao reply address");
  });

  it("stores bounded attachments and dispatches to the routed agent Space with task context", async () => {
    const address = "reply-a1@agents.example.test";
    const routeHash = await hashEmailAddress(address);
    const dispatched: Request[] = [];
    const stored: Array<{ key: string; body: unknown }> = [];
    const mime = [
      "From: Vendor <vendor@example.net>", "To: reply-a1@agents.example.test", "Subject: Quote",
      "Message-ID: <reply-1@example.net>", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b"', "",
      "--b", "Content-Type: text/plain", "", "Quote attached", "--b", 'Content-Type: application/pdf; name="quote.pdf"',
      'Content-Disposition: attachment; filename="quote.pdf"', "Content-Transfer-Encoding: base64", "", "JVBERi0xLjQ=", "--b--", "",
    ].join("\r\n");
    const raw = new TextEncoder().encode(mime);
    const env = makeEnv({
      EMAIL_INGRESS_DOMAIN: "agents.example.test",
      PLATFORM_DB: {
        prepare: (query: string) => ({ bind: () => ({
          first: async () => query.includes("email_reply_routes")
            ? { tenant_id: TENANT, space_id: "s1", task_id: "run-1", agent_id: "quotes-agent", project_id: "p1" }
            : { status: "active" },
          run: async () => ({ success: true }),
        }) }),
      } as never,
      SCRIPTS_R2: { put: async (key: string, body: unknown) => { stored.push({ key, body }); } } as never,
      NAELAO_AGENT_DO: {
        idFromName: () => "do-id",
        get: () => ({ fetch: async (request: Request) => { dispatched.push(request); return Response.json({ queued: true }); } }),
      } as never,
    });
    const message = {
      from: "vendor@example.net", to: address, rawSize: raw.byteLength,
      raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw); controller.close(); } }),
      headers: new Headers(), setReject: vi.fn(), forward: async () => ({} as never), reply: async () => ({} as never),
    } as ForwardableEmailMessage;
    expect(await hashEmailAddress(address)).toBe(routeHash);

    await handleCloudflareEmail(message, env);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.key).toContain("email-inbound/run-1/");
    const payload = await dispatched[0]!.json() as { raw: { text: string }; projectId: string; spaceId: string; tenantId: string };
    expect(payload).toMatchObject({ projectId: "p1", spaceId: "s1", tenantId: TENANT });
    expect(payload.raw.text).toContain("Email reply for task run-1");
    expect(payload.raw.text).toContain("quote.pdf (application/pdf, 8 bytes) attachment:");
    expect(payload.raw.text).not.toContain(stored[0]!.key);
    expect(payload.raw.text).not.toContain("r2://");
  });

  it("routes text-only Cloudflare mailbox messages to the provisioned agent without task scope", async () => {
    const address = await createAgentEmailAddress({ domain: "agents.example.test", tenantId: TENANT, spaceId: "s1", agentId: "mail-agent", secret: SECRET });
    const hash = await hashEmailAddress(address);
    const dispatched: Request[] = [];
    const raw = new TextEncoder().encode([
      "From: Customer <customer@example.net>", `To: ${address}`, "Subject: Need help", "Message-ID: <mail-1@example.net>", "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8", "", "Please help with my order.",
    ].join("\r\n"));
    const env = makeEnv({
      EMAIL_INGRESS_DOMAIN: "agents.example.test",
      PLATFORM_DB: { prepare: (query: string) => ({ bind: () => ({ first: async () => {
        if (query.includes("email_reply_routes")) return null;
        if (query.includes("agent_email_addresses")) return { tenant_id: TENANT, space_id: "s1", agent_id: "mail-agent" };
        return { status: "active" };
      } }) }) } as never,
      NAELAO_AGENT_DO: { idFromName: () => "do-id", get: () => ({ fetch: async (request: Request) => { dispatched.push(request); return Response.json({ queued: true }); } }) } as never,
    });
    const message = {
      from: "customer@example.net", to: address, rawSize: raw.byteLength,
      raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw); controller.close(); } }),
      headers: new Headers(), setReject: vi.fn(), forward: async () => ({} as never), reply: async () => ({} as never),
    } as ForwardableEmailMessage;
    expect(hash).toBe(await hashEmailAddress(address));
    await handleCloudflareEmail(message, env);
    expect(message.setReject).not.toHaveBeenCalled();
    const payload = await dispatched[0]!.json() as { raw: { text: string }; spaceId: string; taskId?: string };
    expect(payload).toMatchObject({ spaceId: "s1" });
    expect(payload.taskId).toBeUndefined();
    expect(payload.raw.text).toContain("Untrusted inbound email");
    expect(payload.raw.text).toContain("Please help with my order.");
  });
});

describe("AgentMail inbound webhook delivery", () => {
  async function signedHeaders(rawBody: string): Promise<Record<string, string>> {
    const id = "evt-retry-test";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const secretBytes = new TextEncoder().encode("webhook-secret");
    const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`));
    const signature = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
  }

  it("returns a retryable failure when the Durable Object rejects or fails the delivery", async () => {
    const rawBody = JSON.stringify({ event_type: "message.received", message: {
      from: "customer@example.test", text: "Please help", message_id: "mail-1",
    } });
    for (const failure of ["throw", "http"] as const) {
      const env = makeEnv({
        PLATFORM_DB: {
          prepare: (query: string) => ({ bind: () => ({ first: async () => {
            if (query.includes("FROM spaces s JOIN orgs o")) return { tenant_id: TENANT, status: "active" };
            if (query.includes("SELECT name, config_json FROM spaces")) return { name: "test", config_json: "{}" };
            return null;
          } }) }),
        } as never,
        CREDENTIALS_WORKER: { fetch: async () => Response.json({ value: `whsec_${btoa("webhook-secret")}` }) } as never,
        NAELAO_AGENT_DO: {
          idFromName: () => "agent-do",
          get: () => ({ fetch: async () => {
            if (failure === "throw") throw new Error("Durable Object unavailable");
            return new Response("failed", { status: 500 });
          } }),
        } as never,
      });
      const response = await app.request("https://agents.naelao.com/channels/email/agentmail-inbound/s1", {
        method: "POST",
        headers: { "content-type": "application/json", ...await signedHeaders(rawBody) },
        body: rawBody,
      }, env as never);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error_code: "inbound_dispatch_failed" });
    }
  });
});
