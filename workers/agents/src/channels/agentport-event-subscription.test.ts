import { describe, expect, it } from "vitest";
import { isCurrentAgentPortSubscription, providerEventRuntimeAgentId } from "./agentport-event-subscription.js";

describe("AgentPort provider-event subscription boundary", () => {
  const event = { subscriptionId: "sub-1", agentId: "agentport-agent-1", accountId: "account-1", serviceId: "agentmail:tenant-1" };

  it("requires an active subscription with exact identity matches", () => {
    expect(isCurrentAgentPortSubscription(event, { ...event, status: "active" })).toBe(true);
    expect(isCurrentAgentPortSubscription(event, { ...event, status: "revoked" })).toBe(false);
    expect(isCurrentAgentPortSubscription(event, { ...event, accountId: "account-2", status: "active" })).toBe(false);
    expect(isCurrentAgentPortSubscription(event, { ...event, agentId: "agentport-agent-2", status: "active" })).toBe(false);
    expect(isCurrentAgentPortSubscription(event, null)).toBe(false);
  });

  it("does not treat an AgentPort identity as a Naelao runtime identity", () => {
    expect(providerEventRuntimeAgentId()).toBe("naelao-agent");
    expect(providerEventRuntimeAgentId()).not.toBe(event.agentId);
  });
});
