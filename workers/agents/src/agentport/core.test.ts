import { describe, expect, it } from "vitest";
import {
  accountModelRequiresParent,
  assertAgentGrant,
  inspectDependencyGraph,
  isLeaseActive,
  leaseExpiry,
  validateServiceRegistration,
} from "./core.js";

describe("AgentPort service and account contracts", () => {
  it("validates an existing provider interface without inventing a connector", () => {
    expect(validateServiceRegistration({
      id: "stripe-mcp", name: "Stripe", type: "mcp", endpoint: "https://mcp.stripe.com",
      accountModels: ["user_parent", "delegated"], capabilities: ["payments.create"], events: ["payment.created"],
      connectionPurpose: "parent_provisioning",
    })).toMatchObject({ id: "stripe-mcp", partnershipStatus: "unaffiliated", accountModels: ["user_parent", "delegated"] });
  });

  it("rejects unsupported account models and oversized service identifiers", () => {
    expect(validateServiceRegistration({ id: "bad", name: "x", type: "api", accountModels: ["superuser"], capabilities: [], events: [], connectionPurpose: "agent_resource" })).toBeNull();
    expect(validateServiceRegistration({ id: "a".repeat(130), name: "x", type: "api", accountModels: ["agent_native"], capabilities: [], events: [], connectionPurpose: "agent_resource" })).toBeNull();
  });

  it("distinguishes parent-backed resources from agent-native resources", () => {
    expect(accountModelRequiresParent("agent_native")).toBe(false);
    for (const model of ["user_parent", "agentport_parent", "delegated"] as const) expect(accountModelRequiresParent(model)).toBe(true);
  });

  it("blocks unresolved provisioning cycles and only warns for recovery/runtime cycles", () => {
    expect(inspectDependencyGraph([
      { accountId: "email", dependsOnAccountId: "phone", type: "provisioning" },
      { accountId: "phone", dependsOnAccountId: "cloud", type: "provisioning" },
      { accountId: "cloud", dependsOnAccountId: "email", type: "provisioning" },
    ]).provisioningCycles).toEqual([["email", "phone", "cloud", "email"]]);
    expect(inspectDependencyGraph([
      { accountId: "email", dependsOnAccountId: "phone", type: "recovery" },
      { accountId: "phone", dependsOnAccountId: "email", type: "recovery" },
    ])).toMatchObject({ provisioningCycles: [], warnings: ["recovery"] });
  });

  it("bounds consumer leases and expires crashed consumers", () => {
    expect(leaseExpiry(1000, 1)).toBe(11000);
    expect(leaseExpiry(1000, 3600)).toBe(901000);
    const lease = { id: "l1", subscriptionId: "s1", consumerId: "runtime:1", expiresAt: 2000 };
    expect(isLeaseActive(lease, 1999)).toBe(true);
    expect(isLeaseActive(lease, 2000)).toBe(false);
  });

  it("checks account, agent, grant, expiry and action permission at use time", () => {
    expect(() => assertAgentGrant({ accountStatus: "active", agentStatus: "active", grantStatus: "active", permission: "mail.read", permissions: ["mail.read"], now: 1000 })).not.toThrow();
    expect(() => assertAgentGrant({ accountStatus: "active", agentStatus: "active", grantStatus: "active", expiresAt: new Date(999).toISOString(), permission: "mail.read", permissions: ["mail.read"], now: 1000 })).toThrow("agentport_grant_expired");
    expect(() => assertAgentGrant({ accountStatus: "active", agentStatus: "active", grantStatus: "active", permission: "mail.send", permissions: ["mail.read"], now: 1000 })).toThrow("agentport_permission_denied");
  });
});
