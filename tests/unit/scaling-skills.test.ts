import { describe, it, expect } from "vitest";
import { LAUNCHPAD_SCALING_SKILLS, seedScalingSkills, type SeedableLibrary } from "../../workers/agents/src/launchpad/scaling-skills.js";

// F-3d: the prebuilt business-scaling skills library — 6 agent-authored skills seeded into each
// Launchpad space so a builder never starts from scratch.

function fakeLibrary(existing: string[] = []): { lib: SeedableLibrary; created: Array<{ name: string; tags?: string[]; requires_tier: number }> } {
  const store = new Set(existing);
  const created: Array<{ name: string; tags?: string[]; requires_tier: number }> = [];
  const lib: SeedableLibrary = {
    async exists(name) { return store.has(name); },
    async create(input) {
      if (store.has(input.name)) throw new Error("exists");
      store.add(input.name);
      created.push({ name: input.name, tags: input.metadata.tags, requires_tier: input.metadata.requires_tier });
      return {};
    },
  };
  return { lib, created };
}

describe("F-3d: LAUNCHPAD_SCALING_SKILLS", () => {
  it("ships exactly the 6 documented skills", () => {
    expect(LAUNCHPAD_SCALING_SKILLS.map((s) => s.name).sort()).toEqual([
      "brand-identity", "customer-retention", "pricing-optimization",
      "sales-outreach", "scaling-zero-to-ten-k", "storefront-setup",
    ]);
  });

  it("each skill has a description, tags for script.find, and syntactically valid run() code", () => {
    for (const skill of LAUNCHPAD_SCALING_SKILLS) {
      expect(skill.description.length).toBeGreaterThan(20);
      expect(skill.tags.length).toBeGreaterThan(2);
      expect(skill.code).toContain("export async function run(args, ctx)");
      // Parsing as a module body proves the code is valid JS (would throw on a syntax error).
      expect(() => new Function(`return (async () => { ${skill.code.replace(/export async function/, "async function")} })`)).not.toThrow();
    }
  });
});

describe("F-3d: seedScalingSkills", () => {
  it("creates all 6 skills as Tier-2, tagged, into an empty library", async () => {
    const { lib, created } = fakeLibrary();
    const names = await seedScalingSkills(lib);
    expect(names.length).toBe(6);
    expect(created.every((c) => c.requires_tier === 2)).toBe(true);
    expect(created.every((c) => (c.tags?.length ?? 0) > 0)).toBe(true);
  });

  it("is idempotent — skips skills that already exist (a re-provision or a builder's fork)", async () => {
    const { lib, created } = fakeLibrary(["scaling-zero-to-ten-k", "storefront-setup"]);
    const names = await seedScalingSkills(lib);
    expect(names.length).toBe(4);
    expect(names).not.toContain("scaling-zero-to-ten-k");
    expect(created.length).toBe(4);
  });

  it("best-effort — one skill's failure doesn't abort the rest", async () => {
    const store = new Set<string>();
    let calls = 0;
    const lib: SeedableLibrary = {
      async exists(name) { return store.has(name); },
      async create(input) { calls++; if (calls === 2) throw new Error("boom"); store.add(input.name); return {}; },
    };
    const names = await seedScalingSkills(lib);
    expect(names.length).toBe(5); // 6 attempted, 1 failed
  });
});
