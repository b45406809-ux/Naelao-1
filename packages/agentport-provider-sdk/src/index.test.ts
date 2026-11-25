import { describe, expect, it, vi } from "vitest";
import { AgentPortClient } from "@agentport/sdk";
import { defineProvider, publishProvider, type ProviderDefinition } from "./index.js";

const provider: ProviderDefinition = {
  id: "example-bank", name: "Example Bank", type: "api", endpoint: "https://api.example.test",
  accountModels: ["user_parent", "agent_native"], capabilities: ["balance.read", "account.create"],
  events: ["account.updated"], connectionPurpose: "parent_provisioning", auth: { type: "oauth2", authorizationUrl: "https://api.example.test/oauth/authorize", scopes: ["balances:read"] },
  provisioning: { mode: "approval_required", requires: ["verified_organization", "bank_approval"] },
  billing: { model: "provider_defined", currency: "USD" }, capabilitySchemas: { "balance.read": {
    type: "object", properties: { accountId: { type: "string", minLength: 1, maxLength: 80 } },
    required: ["accountId"], additionalProperties: false,
  } },
};

describe("AgentPort Provider SDK", () => {
  it("validates and normalizes provider declarations without claiming provider execution", () => {
    const normalized=defineProvider(provider);
    expect(normalized).toMatchObject({
      id: "example-bank", auth: { type: "oauth2" },
      provisioning: { mode: "approval_required" }, billing: { model: "provider_defined" },
      accountModels: ["user_parent", "agent_native"],
    });
    expect(normalized.capabilitySchemas).toEqual(provider.capabilitySchemas);
    expect(() => defineProvider({ ...provider, endpoint: "http://insecure.example.test" })).toThrow(/HTTPS/);
    expect(() => defineProvider({ ...provider, billing: { model: "fixed", currency: "US" } })).toThrow(/currency/);
    expect(() => defineProvider({ ...provider, capabilitySchemas: { "account.delete": provider.capabilitySchemas!["balance.read"] } }))
      .toThrow(/declared capabilities/);
    expect(() => defineProvider({ ...provider, capabilitySchemas: { "balance.read": {
      type: "object", properties: { accountId: { type: "string" } }, additionalProperties: true,
    } as never } })).toThrow(/declared capabilities/);
    expect(() => defineProvider({ ...provider, capabilitySchemas: { "balance.read": {
      type: "object", properties: { accountId: { type: "string", providerSecret: "exposed" } }, additionalProperties: false,
    } as never } })).toThrow(/declared capabilities/);
  });

  it("publishes the normalized manifest through the AgentPort API client", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ service: JSON.parse(String(init?.body)) }), { status: 201 }));
    const client = new AgentPortClient({ apiKey: "test", fetch: fetcher as typeof fetch });
    const result = await publishProvider(client, provider);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://agentport.naelao.com/v1/services");
    expect(result.service).toMatchObject({ auth: { type: "oauth2" }, provisioning: { mode: "approval_required" } });
    expect(result.service.capabilitySchemas).toEqual(provider.capabilitySchemas);
    expect(result.service).not.toHaveProperty("grants");
  });
});
