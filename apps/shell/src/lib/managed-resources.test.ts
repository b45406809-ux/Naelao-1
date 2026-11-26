import { describe, expect, it } from "vitest";
import { parseManagedResources, resourceModeLabel, resourceTitle } from "./managed-resources.js";

const good = { id: "r1", providerName: "AgentMail", status: "active", mode: "managed", displayName: "Support", category: "email", resourceType: "email_inbox",
  region: "us", projectId: null, assignedAgents: [{ agentId: "a1" }, { agentId: 3 }],
  usage: { periodStart: "2026-11-01T00:00:00.000Z", periodEnd: "2026-12-01T00:00:00.000Z", operations: 3, settledCredits: 7, heldCredits: 1 },
  price: { credits: 100, interval: "month" }, renewal: { state: "active", currentPeriodEnd: "2026-12-01T00:00:00.000Z", cancelAtPeriodEnd: true } };

describe("managed resources parser", () => {
  it("keeps the display fields and drops unknown or internal ones", () => {
    const [r] = parseManagedResources({ resources: [{ ...good, provisioning_strategy: "managed_master", credential_ref: "vault", providerResourceRef: "x" }] });
    expect(r).toMatchObject({ id: "r1", providerName: "AgentMail", mode: "managed", assignedAgents: ["a1"], price: { credits: 100 }, renewal: { cancelAtPeriodEnd: true },
      usage: { operations: 3, settledCredits: 7, heldCredits: 1 } });
    expect(JSON.stringify(r)).not.toMatch(/managed_master|vault|providerResourceRef|provisioning/);
  });

  it("skips malformed rows and tolerates missing sections", () => {
    expect(parseManagedResources(null)).toEqual([]);
    expect(parseManagedResources({ resources: "no" })).toEqual([]);
    const rows = parseManagedResources({ resources: [null, { id: "x" }, { id: "r2", providerName: "Telnyx", status: "suspended", mode: "byok" }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "r2", mode: "byok", assignedAgents: [], price: null, renewal: null, usage: { operations: 0 } });
  });

  it("labels modes and titles", () => {
    expect(resourceModeLabel("managed")).toBe("Managed");
    expect(resourceModeLabel("byok")).toBe("Bring your own");
    expect(resourceTitle({ displayName: null, providerName: "AgentMail" })).toBe("AgentMail");
    expect(resourceTitle({ displayName: "Support", providerName: "AgentMail" })).toBe("Support (AgentMail)");
  });
});
