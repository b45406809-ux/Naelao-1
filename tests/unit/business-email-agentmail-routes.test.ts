import { describe, expect, it, vi } from "vitest";
import { app, handleCloudflareEmail } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { hashEmailAddress } from "../../workers/agents/src/channels/cloudflare-email.js";

const TENANT = "tenant-1";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(over: Partial<AgentsEnv> = {}): AgentsEnv {
  return {
    PLATFORM_SECRET: "test-platform-secret",
    PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    ...over,
  } as unknown as AgentsEnv;
}

describe("retired business mailbox routes", () => {
  it.each([
    "/internal/business-email/provision",
    "/internal/business-email/send",
    "/internal/business-email/reply-address",
    "/internal/business-email/attachment/read-text",
    "/channels/email/agentmail-inbound/space-1",
  ])("does not expose the retired route %s", async (path) => {
    const send = vi.fn();
    const env = makeEnv({ EMAIL: { send } as never });
    const response = await app.fetch(
      new Request(`https://agents.naelao.com${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: TENANT, spaceId: "space-1", to: "recipient@example.test" }),
      }),
      env as never,
      execCtx,
    );
    expect(response.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Cloudflare task reply email handler", () => {
  function message(to: string, raw: Uint8Array) {
    return {
      from: "vendor@example.net",
      to,
      rawSize: raw.byteLength,
      raw: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(raw);
          controller.close();
        },
      }),
      headers: new Headers(),
      setReject: vi.fn(),
      forward: async () => ({} as never),
      reply: async () => ({} as never),
    } as ForwardableEmailMessage;
  }

  it("rejects unknown aliases before parsing or dispatching email", async () => {
    const setReject = vi.fn();
    const env = makeEnv({
      EMAIL_INGRESS_DOMAIN: "agents.example.test",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as never,
    });
    await handleCloudflareEmail({
      from: "vendor@example.net",
      to: "unknown@agents.example.test",
      rawSize: 20,
      raw: new ReadableStream<Uint8Array>(),
      headers: new Headers(),
      setReject,
      forward: async () => ({} as never),
      reply: async () => ({} as never),
    } as ForwardableEmailMessage, env);
    expect(setReject).toHaveBeenCalledWith("Unknown or expired Naelao reply address");
  });

  it("stores bounded attachments and dispatches to the task's scoped assistant", async () => {
    const address = "reply-a1@agents.example.test";
    const routeHash = await hashEmailAddress(address);
    const dispatched: Request[] = [];
    const stored: Array<{ key: string; body: unknown }> = [];
    const raw = new TextEncoder().encode([
      "From: Vendor <vendor@example.net>",
      `To: ${address}`,
      "Subject: Quote",
      "Message-ID: <reply-1@example.net>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "Quote attached",
      "--b",
      'Content-Type: application/pdf; name="quote.pdf"',
      'Content-Disposition: attachment; filename="quote.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQ=",
      "--b--",
      "",
    ].join("\r\n"));
    const env = makeEnv({
      EMAIL_INGRESS_DOMAIN: "agents.example.test",
      PLATFORM_DB: {
        prepare: (query: string) => ({
          bind: () => ({
            first: async () => {
              // These email addresses belong to task replies, not assistant inbox identities.
              if (query.includes("assistant_communication_identities") || query.includes("assistant_communication_aliases") || query.includes("project_agent_email_addresses")) return null;
              if (query.includes("email_reply_routes")) return {
                tenant_id: TENANT,
                space_id: "s1",
                task_id: "run-1",
                agent_id: "quotes-agent",
                project_id: "p1",
              };
              if (query.includes("FROM spaces s")) return { id: "s1", status: "active" };
              return null;
            },
            run: async () => ({ success: true }),
          }),
        }),
      } as never,
      SCRIPTS_R2: { put: async (key: string, body: unknown) => { stored.push({ key, body }); } } as never,
      NAELAO_AGENT_DO: {
        idFromName: () => "do-id",
        get: () => ({ fetch: async (request: Request) => { dispatched.push(request); return Response.json({ queued: true }); } }),
      } as never,
    });
    const incoming = message(address, raw);

    expect(await hashEmailAddress(address)).toBe(routeHash);
    await handleCloudflareEmail(incoming, env);

    expect(incoming.setReject).not.toHaveBeenCalled();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.key).toContain("email-inbound/run-1/");
    const payload = await dispatched[0]!.json() as { raw: { text: string }; projectId: string; spaceId: string; tenantId: string };
    expect(payload).toMatchObject({ projectId: "p1", spaceId: "s1", tenantId: TENANT });
    expect(payload.raw.text).toContain("Email reply for task run-1");
    expect(payload.raw.text).toContain("quote.pdf (application/pdf, 8 bytes) attachment:");
    expect(payload.raw.text).not.toContain(stored[0]!.key);
    expect(payload.raw.text).not.toContain("r2://");
  });
});
