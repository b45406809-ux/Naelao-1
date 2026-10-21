import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class {} }));
vi.mock("agents/voice", () => ({
  withVoice: (Base: new (...args: never[]) => object) => Base,
  WorkersAIFluxSTT: class {},
}));

import { CustomerVoiceAgent } from "./customer-voice-agent.js";

function harness() {
  let tenantActive = true;
  const aiRun = vi.fn(async () => {
    tenantActive = false;
    return { response: "The answer should not be spoken." };
  });
  const db = {
    prepare: (query: string) => ({ bind: () => ({ first: async () => {
      if (query.includes("JOIN orgs")) return tenantActive ? { id: "space-a" } : null;
      if (query.includes("customer_voice_number_bindings")) return { id: "binding-a" };
      return { config_json: "{}" };
    } }) }),
  };
  const agent = Object.create(CustomerVoiceAgent.prototype) as CustomerVoiceAgent & { env: unknown; ctx: unknown };
  Object.assign(agent, {
    env: { PLATFORM_DB: db, AI: { run: aiRun } },
    ctx: { id: { name: "call-a" } },
  });
  const closed: Array<[number, string]> = [];
  const ticket = { callSid: "call-a", tenantId: "tenant-a", spaceId: "space-a", bindingId: "binding-a", agentId: "agent-a", called: "+15550001111", nonce: "nonce-a" };
  const binding = { assistant_prompt: "Be helpful.", status: "active" };
  const context = {
    connection: { state: { ticket, binding }, close: (code: number, reason: string) => closed.push([code, reason]) },
    messages: [], signal: new AbortController().signal,
  };
  return { agent, context, aiRun, closed, setTenantActive: (active: boolean) => { tenantActive = active; } };
}

describe("customer voice suspension revocation", () => {
  it("does not start a model turn when the tenant is already suspended", async () => {
    const h = harness();
    h.setTenantActive(false);
    await expect(h.agent.onTurn("Question", h.context as never)).rejects.toThrow("customer_voice_egress_denied");
    expect(h.aiRun).not.toHaveBeenCalled();
    expect(h.closed).toEqual([[1008, "tenant_suspended"]]);
  });

  it("drops a model response if suspension happens during inference", async () => {
    const h = harness();
    await expect(h.agent.onTurn("Question", h.context as never)).rejects.toThrow("tenant_suspended");
    expect(h.aiRun).toHaveBeenCalledOnce();
    expect(h.closed).toEqual([[1008, "tenant_suspended"]]);
  });
});
