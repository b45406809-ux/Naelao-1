import { describe, expect, it } from "vitest";
import { describeComponent, parseManagedResources, parseResourceOptions, parseResourceQuote, resourceModeLabel, resourceTitle } from "./managed-resources.js";

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

describe("add-resource parsers", () => {
  const components = [{ kind: "setup", credits: 10 }, { kind: "rental", interval: "month", credits: 100 },
    { kind: "usage", meter: "sends", included: 1000, unitQty: 1000, unitCredits: 5 }, { kind: "bogus" }];
  it("parses options and the reason, dropping malformed rows and internal fields", () => {
    const parsed = parseResourceOptions({ selectedOfferingId: "o1", reason: "Because", options: [
      { offeringId: "o1", displayName: "Inbox", region: "us", recurring: true, components, minMonthlyCredits: 100, initialCredits: 110, strategy: "managed_master" },
      { offeringId: "o2" }, null] });
    expect(parsed.selectedOfferingId).toBe("o1");
    expect(parsed.reason).toBe("Because");
    expect(parsed.options).toHaveLength(1);
    expect(parsed.options[0]!.components).toHaveLength(3);
    expect(JSON.stringify(parsed)).not.toMatch(/managed_master/);
    expect(parseResourceOptions(null)).toEqual({ options: [], selectedOfferingId: null, reason: "" });
  });
  it("parses a quote with every component and describes them", () => {
    const quote = parseResourceQuote({ reason: "You chose it", quote: { quoteId: "msq_1", offeringId: "o1", region: "us", credits: 110, minMonthlyCredits: 100, components, expiresAt: "2026-11-26T12:15:00.000Z" } });
    expect(quote).toMatchObject({ quoteId: "msq_1", credits: 110, minMonthlyCredits: 100 });
    expect(quote!.components.map(describeComponent)).toEqual(["Setup: 10 credits, once", "Rental: 100 credits per month", "Usage (sends): first 1000 included, then 5 credits per 1000"]);
    expect(parseResourceQuote({ quote: { quoteId: "x" } })).toBeNull();
    expect(parseResourceQuote(undefined)).toBeNull();
  });
});
