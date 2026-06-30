import { describe, it, expect } from "vitest";
import { SkillLibrary } from "../../workers/agents/src/script-engine/skill-library.js";
import { promoteSkill, inheritTemplateSkills, isPromotable } from "../../workers/agents/src/script-engine/federation.js";
import type { ScriptMetadata } from "../../workers/agents/src/script-engine/types.js";

// Minimal in-memory R2 bucket (only the surface SkillLibrary uses).
function fakeBucket() {
  const store = new Map<string, string>();
  return {
    async head(key: string) { return store.has(key) ? { key } : null; },
    async get(key: string) {
      if (!store.has(key)) return null;
      const v = store.get(key)!;
      return { async text() { return v; } };
    },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list(opts?: { prefix?: string; cursor?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
      return { objects, truncated: false, cursor: undefined };
    },
    _store: store,
  } as unknown as R2Bucket;
}

function meta(name: string, over: Partial<ScriptMetadata> = {}): ScriptMetadata {
  return {
    name, version: 1, domain: "api", description: `${name} skill`, tags: [],
    fingerprint_schema: {}, preconditions: [], parameters: [], calls: [], requires_tier: 2,
    success_count: 0, failure_count: 0, patch_history: [], stability_score: 0.5,
    origin: "distilled", created_at: Date.now(), updated_at: Date.now(), ...over,
  };
}

describe("federated template learning (A1.9)", () => {
  it("isPromotable gates on stability + successes", () => {
    expect(isPromotable({ stability_score: 0.9, success_count: 6 })).toBe(true);
    expect(isPromotable({ stability_score: 0.9, success_count: 4 })).toBe(false);
    expect(isPromotable({ stability_score: 0.7, success_count: 9 })).toBe(false);
  });

  it("refuses to promote an unproven skill", async () => {
    const bucket = fakeBucket();
    const space = new SkillLibrary(bucket, "space-1");
    const template = SkillLibrary.forTemplate(bucket, "whop-seller");
    await space.create({ name: "draft-whop-reply", code: "x", metadata: meta("draft-whop-reply", { success_count: 1, stability_score: 0.4 }) });

    const res = await promoteSkill(space, template, "draft-whop-reply");
    expect(res.promoted).toBe(false);
    expect(await template.exists("draft-whop-reply")).toBe(false);
  });

  it("promotes a proven skill to the shared template library (health reset, origin authored)", async () => {
    const bucket = fakeBucket();
    const space = new SkillLibrary(bucket, "space-1");
    const template = SkillLibrary.forTemplate(bucket, "whop-seller");
    // import() preserves the proven health counters (create() resets them — unproven by design).
    await space.import(meta("whop-welcome-dm", { success_count: 8, stability_score: 0.92 }), "export default 1", "distilled");

    const res = await promoteSkill(space, template, "whop-welcome-dm");
    expect(res.promoted).toBe(true);
    const shared = await template.read("whop-welcome-dm");
    expect(shared?.metadata.origin).toBe("authored");
    expect(shared?.metadata.success_count).toBe(0); // earns its own fleet track record
    expect(shared?.code).toBe("export default 1");
  });

  it("a second space inherits the shared skill but keeps its own version", async () => {
    const bucket = fakeBucket();
    const s1 = new SkillLibrary(bucket, "space-1");
    const template = SkillLibrary.forTemplate(bucket, "whop-seller");
    await s1.import(meta("whop-welcome-dm", { success_count: 8, stability_score: 0.92 }), "v-from-s1", "distilled");
    await promoteSkill(s1, template, "whop-welcome-dm");

    const s2 = new SkillLibrary(bucket, "space-2");
    // s2 already has its own learned variant of one skill — inherit must not clobber it.
    await s2.create({ name: "whop-welcome-dm", code: "v-from-s2", metadata: meta("whop-welcome-dm") });
    await template.import(meta("whop-faq", { origin: "authored" }), "faq-code", "seed");

    const res = await inheritTemplateSkills(template, s2);
    expect(res.inherited).toContain("whop-faq");
    expect(res.skipped).toContain("whop-welcome-dm");
    expect((await s2.read("whop-welcome-dm"))?.code).toBe("v-from-s2"); // own version preserved
    expect(await s2.exists("whop-faq")).toBe(true);
  });
});
