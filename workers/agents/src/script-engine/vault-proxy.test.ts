import { describe, expect, it, vi } from "vitest";
import { createVaultProxy } from "./vault-proxy.js";

describe("vault proxy", () => {
  it("rejects guest-selected audio streaming before credential egress", async () => {
    const fetch = vi.fn();
    const vault = createVaultProxy({ credentialsWorker: { fetch } as unknown as Fetcher, platformSecret: "s", tenantId: "t", spaceId: "s", agentId: "user-worker" });
    await expect(vault.fetchWithAuth("https://openrouter.ai/api/v1/audio/speech", { credentialName: "OPENROUTER_KEY", method: "POST", responseMode: "audio" })).rejects.toThrow("audio_stream_requires_host_adapter");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends only a logical credential name to the isolate-facing proxy", async () => {
    const fetch = vi.fn(async (request: Request) => {
      const payload = await request.json<Record<string, unknown>>();
      expect(payload.credentialName).toBe("STRIPE_KEY");
      expect(request.headers.get("x-naelao-credential-token")).toMatch(
        /^t=.+,aid=agent,/
      );
      return new Response("ok", { headers: { "x-safe": "yes" } });
    });
    const vault = createVaultProxy({
      credentialsWorker: { fetch } as unknown as Fetcher,
      platformSecret: "platform",
      tenantId: "t",
      spaceId: "s",
      agentId: "agent",
    });
    const response = await vault.fetchWithAuth(
      "https://api.stripe.com/v1/test",
      { credentialName: "STRIPE_KEY" }
    );
    expect(await response.text()).toBe("ok");
    expect(JSON.stringify(vault)).not.toContain("platform");
  });

  it("signs the acting user into a read-only credential scope when the caller has no run ID", async () => {
    let token = "";
    let payload: Record<string, unknown> = {};
    const vault = createVaultProxy({
      credentialsWorker: {
        fetch: async (request: Request) => {
          token = request.headers.get("x-naelao-credential-token") ?? "";
          payload = await request.json() as Record<string, unknown>;
          return new Response("ok");
        },
      } as unknown as Fetcher,
      platformSecret: "platform",
      tenantId: "tenant",
      spaceId: "space",
      agentId: "agent",
      userId: "actor-42",
    });

    await vault.fetchWithAuth("https://api.example.test", { credentialName: "SERVICE_KEY" });
    expect(token).toContain(",uid=actor-42,");
    expect(token).toContain(",v4=");
    expect(payload.onBehalfOfUserId).toBe("actor-42");
  });

  it("forwards an explicit Basic-auth mode and username through the signed vault boundary", async () => {
    const fetch = vi.fn(async (request: Request) => {
      const payload = await request.json<Record<string, unknown>>();
      expect(payload.auth).toEqual({ type: "basic", username: "AC123" });
      expect(payload.credentialName).toBe("TWILIO_AUTH_TOKEN");
      return new Response("ok");
    });
    const vault = createVaultProxy({
      credentialsWorker: { fetch } as unknown as Fetcher,
      platformSecret: "platform",
      tenantId: "t",
      spaceId: "s",
      agentId: "agent",
    });
    await vault.fetchWithAuth("https://api.twilio.com/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json", {
      credentialName: "TWILIO_AUTH_TOKEN",
      auth: { type: "basic", username: "AC123" },
    });
  });

  it("bounds error responses from the Credentials Worker", async () => {
    const vault = createVaultProxy({
      credentialsWorker: {
        fetch: async () =>
          new Response("provider error", {
            status: 502,
            headers: { "content-length": String(8 * 1024 + 1) },
          }),
      } as unknown as Fetcher,
      platformSecret: "platform",
      tenantId: "t",
      spaceId: "s",
      agentId: "agent",
    });
    await expect(
      vault.fetchWithAuth("https://api.example.test", {
        credentialName: "SERVICE_KEY",
      })
    ).rejects.toThrow("Vault egress failed (502):");
  });
});
