import { describe, it, expect } from "vitest";
import {
  LAUNCHPAD_SPACETYPE,
  LAUNCHPAD_TEMPLATES,
  LAUNCHPAD_CORE_AGENTS,
  getLaunchpadTemplate,
  agentsForTemplate,
  agentsForTemplates,
  validateLaunchpadSpaceType,
} from "../../workers/agents/src/launchpad/spacetype.js";

// Launchpad SpaceType per original spec §11 — "AI-Run Digital Business".
// SpaceType differences live in config / agent definitions / manifests, never DB tables.

describe("Launchpad SpaceType (§11)", () => {
  it("is the launchpad space type with the business-model templates + the Whop-seller and web-studio platform templates", () => {
    expect(LAUNCHPAD_SPACETYPE.id).toBe("launchpad");
    expect(LAUNCHPAD_TEMPLATES.map(t => t.id).sort()).toEqual(
      // Step 28: six "just create it and start earning" business templates added alongside the
      // originals — paid-audit, interactive-tool, productized-service, intelligence-vault,
      // digital-toolkit, niche-community.
      [
        "coaching-community", "creator-store", "customer-service", "digital-toolkit",
        "intelligence-vault", "interactive-tool", "micro-saas", "newsletter-business",
        "niche-community", "paid-audit", "productized-service", "service-agency",
        "whop-seller", "whop-webdev-agency",
      ],
    );
  });

  it("ships the core agent definitions in the §11 shape (fulfillment is canonical)", () => {
    const fulfillment = LAUNCHPAD_CORE_AGENTS.find(a => a.id === "launchpad-fulfillment-v1");
    expect(fulfillment).toBeDefined();
    // Fix B: Lemon Squeezy is the platform's payment rail — never a builder's own Stripe key
    // (spec Appendix H / CLAUDE.md #9). source used to say "stripe-app"; the reserved `commerce`
    // prebuilt is what actually processes money-in.
    expect(fulfillment!.trigger).toEqual({ type: "webhook", event: "order.completed", source: "commerce" });
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

  // Phase C (§A1.17): a business can be built from more than one template — the union must be
  // deduped by agent id (creator-store and newsletter-business both install
  // launchpad-fulfillment-v1, so it should only appear once).
  it("agentsForTemplates unions multiple templates' agents, deduped by id", () => {
    const combined = agentsForTemplates(["creator-store", "newsletter-business"]);
    const ids = combined.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("launchpad-fulfillment-v1");
    expect(ids).toContain("launchpad-support-v1");
    expect(ids).toContain("launchpad-content-v1");
    // Union, not concatenation — fulfillment appears in both source templates but only once here.
    expect(ids.filter((id) => id === "launchpad-fulfillment-v1")).toHaveLength(1);
  });

  it("agentsForTemplates ignores unknown template ids and returns [] for an empty list", () => {
    expect(agentsForTemplates([])).toEqual([]);
    expect(agentsForTemplates(["does-not-exist"])).toEqual([]);
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
