import { describe, expect, it, vi } from "vitest";
import { createVaultProxy } from "./vault-proxy.js";

describe("vault proxy", () => {
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
