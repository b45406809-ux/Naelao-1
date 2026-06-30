import { describe, it, expect } from "vitest";
import {
  LAUNCHPAD_SPACETYPE,
  LAUNCHPAD_TEMPLATES,
  LAUNCHPAD_CORE_AGENTS,
  getLaunchpadTemplate,
  agentsForTemplate,
  validateLaunchpadSpaceType,
} from "../../workers/agents/src/launchpad/spacetype.js";

// Launchpad SpaceType per original spec §11 — "AI-Run Digital Business".
// SpaceType differences live in config / agent definitions / manifests, never DB tables.

describe("Launchpad SpaceType (§11)", () => {
  it("is the launchpad space type with the five business-model templates + the Whop-seller platform template", () => {
    expect(LAUNCHPAD_SPACETYPE.id).toBe("launchpad");
    expect(LAUNCHPAD_TEMPLATES.map(t => t.id).sort()).toEqual(
      ["coaching-community", "creator-store", "micro-saas", "newsletter-business", "service-agency", "whop-seller"],
    );
  });

  it("ships the core agent definitions in the §11 shape (fulfillment is canonical)", () => {
    const fulfillment = LAUNCHPAD_CORE_AGENTS.find(a => a.id === "launchpad-fulfillment-v1");
    expect(fulfillment).toBeDefined();
    expect(fulfillment!.trigger).toEqual({ type: "webhook", event: "order.completed", source: "stripe-app" });
    expect(fulfillment!.requires_approval_for).toContain("customer_email_send");
    expect(fulfillment!.max_spend_per_action_usd).toBe(0); // no autonomous spend by default
  });

  it("every template references only known core agents", () => {
    expect(() => validateLaunchpadSpaceType()).not.toThrow();
    for (const t of LAUNCHPAD_TEMPLATES) {
      const agents = agentsForTemplate(t.id);
      expect(agents.length).toBe(t.agents.length);
    }
  });

  it("resolves a template by id and rejects unknown ids", () => {
    expect(getLaunchpadTemplate("creator-store")?.name).toBe("Creator Store");
    expect(getLaunchpadTemplate("does-not-exist")).toBeNull();
    expect(agentsForTemplate("does-not-exist")).toEqual([]);
  });

  it("validate throws when a template points at a missing agent", () => {
    expect(() =>
      validateLaunchpadSpaceType({
        ...LAUNCHPAD_SPACETYPE,
        templates: [{ id: "x", name: "X", description: "", agents: ["nope-v1"], skills: [], free_tier_eligible: true }],
      }),
    ).toThrow(/unknown core agent/);
  });
});
