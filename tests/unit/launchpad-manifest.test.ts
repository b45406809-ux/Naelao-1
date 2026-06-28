import { describe, it, expect } from "vitest";
import { getManifest, listManifests, validateManifest, CAPABILITY_KERNEL, BASE_SKILLS } from "../../workers/agents/src/launchpad/manifest.js";

// The de-hardcoding layer: a niche / a custom business / an assistant are all just
// manifests (data) loaded into the same script-first engine.

describe("manifest registry", () => {
  it("resolves the Whop niche by id (and alias)", () => {
    expect(getManifest("whop-businesses-v1").kind).toBe("niche");
    expect(getManifest("whop-businesses").id).toBe("whop-businesses-v1");
    expect(getManifest("whop-businesses-v1").seed_scripts.length).toBe(7);
  });

  it("custom is an L4 niche with no seed scripts and a higher cost", () => {
    const m = getManifest("custom");
    expect(m.kind).toBe("niche");
    expect(m.seed_scripts).toHaveLength(0);
    expect(m.cost_multiplier).toBeGreaterThan(1);
  });

  it("an assistant is the same engine + a channel bundle", () => {
    const m = getManifest("support-assistant");
    expect(m.kind).toBe("assistant");
    expect(m.channels && m.channels.length).toBeGreaterThan(0);
  });

  it("unknown ids fall back to custom (safe default → L4)", () => {
    expect(getManifest("does-not-exist").id).toBe("custom");
    expect(getManifest(null).id).toBe("custom");
  });

  it("every manifest stays inside the capability kernel (appendix @3614922)", () => {
    for (const m of listManifests()) {
      expect(() => validateManifest(m)).not.toThrow();
      for (const cap of m.capabilities) expect(CAPABILITY_KERNEL.has(cap)).toBe(true);
    }
  });

  it("rejects a manifest that invents a capability outside the kernel", () => {
    expect(() => validateManifest({
      id: "rogue", kind: "niche", name: "x", description: "x", instructions: "x".repeat(30),
      skills: [], seed_scripts: [], capabilities: ["launch_missiles"], cost_multiplier: 1,
    })).toThrow(/capability kernel/);
  });

  it("every manifest inherits the base skills (appendix @3617022)", () => {
    for (const m of listManifests()) {
      for (const base of BASE_SKILLS) expect(m.skills).toContain(base);
    }
  });

  it("every manifest is well-formed", () => {
    for (const m of listManifests()) {
      expect(m.id).toBeTruthy();
      expect(["niche", "assistant"]).toContain(m.kind);
      expect(m.instructions.length).toBeGreaterThan(20);
      expect(m.cost_multiplier).toBeGreaterThanOrEqual(1);
      // seed scripts must carry real code + a valid tier
      for (const s of m.seed_scripts) {
        expect(s.code.length).toBeGreaterThan(5);
        expect([1, 2, 5]).toContain(s.tier);
      }
    }
  });
});
