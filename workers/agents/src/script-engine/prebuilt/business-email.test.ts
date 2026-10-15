import { describe, expect, it } from "vitest";
import type { PrebuiltOpContext } from "./index.js";
import { businessEmail } from "./business-email.js";

function context(options: {
  agentResponse: Record<string, unknown>;
  notificationResponse?: Record<string, unknown>;
}): { ctx: PrebuiltOpContext; notificationCalls: number } {
  let notificationCalls = 0;
  const ctx = {
    env: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      platformSecret: "platform-secret",
      agentsWorker: {
        fetch: async () => Response.json(options.agentResponse),
      },
      notificationsWorker: {
        fetch: async () => {
          notificationCalls++;
          return Response.json(options.notificationResponse ?? { delivered: true });
        },
      },
    },
  } as unknown as PrebuiltOpContext;
  return { ctx, get notificationCalls() { return notificationCalls; } };
}

describe("business-email Cloudflare Email Service routing", () => {
  it("returns the native provider receipt without calling Resend", async () => {
    const state = context({
      agentResponse: { ok: true, configured: true, provider: "cloudflare_email", messageId: "cf-1", from: "space-0123456789abcdef@mail.example.com" },
    });
    const result = await businessEmail.operations["email.send"]!({
      to: "recipient@example.net", subject: "Hello", body: "Text body",
    }, state.ctx) as { delivered: boolean; provider: string; message_id: string; from: string };

    expect(result).toEqual({
      delivered: true,
      provider: "cloudflare_email",
      message_id: "cf-1",
      from: "space-0123456789abcdef@mail.example.com",
    });
    expect(state.notificationCalls).toBe(0);
  });

  it("reports a Cloudflare sender alias as outbound-only during provisioning", async () => {
    const state = context({
      agentResponse: {
        ok: true,
        configured: true,
        provider: "cloudflare_email",
        email: "space-0123456789abcdef@mail.example.com",
        inbound_wired: false,
      },
    });
    const result = await businessEmail.operations["email.provision"]!({ slug: "operations" }, state.ctx) as Record<string, unknown>;

    expect(result).toMatchObject({
      address: "space-0123456789abcdef@mail.example.com",
      inbound: false,
      provider: "cloudflare_email",
      note: "This is an outbound sender alias; inbound email is not enabled for it.",
    });
  });

  it("does not silently fall through to Resend after an ambiguous native send failure", async () => {
    const state = context({
      agentResponse: { ok: false, configured: true, provider: "cloudflare_email", error: "delivery status unknown" },
    });

    await expect(businessEmail.operations["email.send"]!({ to: "recipient@example.net" }, state.ctx))
      .rejects.toThrow("Cloudflare Email Service send failed: delivery status unknown");
    expect(state.notificationCalls).toBe(0);
  });

  it("keeps the existing notification fallback when no hosted/native provider is configured", async () => {
    const state = context({
      agentResponse: { ok: false, configured: false, reason: "no_outbound_email_provider" },
    });
    const result = await businessEmail.operations["email.send"]!({ to: "recipient@example.net" }, state.ctx) as {
      delivered: boolean;
      provider: string;
    };

    expect(result).toMatchObject({ delivered: true, provider: "resend" });
    expect(state.notificationCalls).toBe(1);
  });
});
