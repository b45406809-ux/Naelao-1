import { describe, expect, it, vi } from "vitest";
import { AgentPortClient } from "@agentport/sdk";
import { defineProvider, publishProvider, type ProviderDefinition } from "./index.js";

const provider: ProviderDefinition = {
  id: "example-bank", name: "Example Bank", type: "api", endpoint: "https://api.example.test",
  accountModels: ["user_parent", "agent_native"], capabilities: ["balance.read", "account.create"],
  events: ["account.updated"], connectionPurpose: "parent_provisioning", auth: { type: "oauth2", authorizationUrl: "https://api.example.test/oauth/authorize", scopes: ["balances:read"] },
  provisioning: { mode: "approval_required", requires: ["verified_organization", "bank_approval"] },
  billing: { model: "provider_defined", currency: "USD" }, capabilitySchemas: { "balance.read": { type: "object" } },
};

describe("AgentPort Provider SDK", () => {
  it("validates and normalizes provider declarations without claiming provider execution", () => {
    expect(defineProvider(provider)).toMatchObject({
      id: "example-bank", auth: { type: "oauth2" },
      provisioning: { mode: "approval_required" }, billing: { model: "provider_defined" },
      accountModels: ["user_parent", "agent_native"],
    });
    expect(() => defineProvider({ ...provider, endpoint: "http://insecure.example.test" })).toThrow(/HTTPS/);
    expect(() => defineProvider({ ...provider, billing: { model: "fixed", currency: "US" } })).toThrow(/currency/);
  });

  it("publishes the normalized manifest through the AgentPort API client", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ service: JSON.parse(String(init?.body)) }), { status: 201 }));
    const client = new AgentPortClient({ apiKey: "test", fetch: fetcher as typeof fetch });
    const result = await publishProvider(client, provider);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://agentport.naelao.com/v1/services");
    expect(result.service).toMatchObject({ auth: { type: "oauth2" }, provisioning: { mode: "approval_required" } });
  });
});
