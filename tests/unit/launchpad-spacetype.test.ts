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

describe("default SpaceType", () => {
  it("is a generic Naelao Space with no hardcoded product templates or personas", () => {
    expect(LAUNCHPAD_SPACETYPE.id).toBe("launchpad");
    expect(LAUNCHPAD_SPACETYPE.description).toContain("General Naelao Space");
    expect(LAUNCHPAD_TEMPLATES).toEqual([]);
    expect(LAUNCHPAD_CORE_AGENTS).toEqual([]);
    expect(getLaunchpadTemplate("whop-seller")).toBeNull();
    expect(getLaunchpadTemplate("does-not-exist")).toBeNull();
    expect(agentsForTemplate("does-not-exist")).toEqual([]);
    expect(agentsForTemplates([])).toEqual([]);
    expect(agentsForTemplates(["whop-seller", "creator-store"])).toEqual([]);
  });

  it("validates the empty generic catalog and rejects template-specific worker personas", () => {
    expect(() => validateLaunchpadSpaceType()).not.toThrow();
    expect(() => validateLaunchpadSpaceType({
      ...LAUNCHPAD_SPACETYPE,
      templates: [{
        id: "bad-persona", name: "Bad Persona", description: "", agents: ["launchpad-support-v1"],
        skills: [], free_tier_eligible: true,
      }],
    })).toThrow(/unknown core agent/);
  });
});
