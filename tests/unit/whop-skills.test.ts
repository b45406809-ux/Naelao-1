import { describe, it, expect } from "vitest";
import { SKILLS, skillsForTier, renderSkillsPrompt } from "../../workers/agents/src/whop/skills.js";

// Prebuilt skills + instructions (Project Think getSkills() style).

describe("skills catalog", () => {
  it("ships a non-empty prebuilt catalog with instructions", () => {
    expect(SKILLS.length).toBeGreaterThan(0);
    for (const s of SKILLS) {
      expect(s.instructions.length).toBeGreaterThan(10);
      expect([1, 2, 3]).toContain(s.min_tier);
    }
  });

  it("gates skills by autonomy tier", () => {
    const t1 = skillsForTier(1).length;
    const t2 = skillsForTier(2).length;
    const t3 = skillsForTier(3).length;
    expect(t1).toBeLessThanOrEqual(t2);
    expect(t2).toBeLessThanOrEqual(t3);
    expect(t3).toBe(SKILLS.length); // Tier 3 sees everything
  });

  it("Tier 1 cannot see Tier-3-only skills (e.g. pricing)", () => {
    const names = skillsForTier(1).map((s) => s.id);
    expect(names).not.toContain("pricing-guarded");
  });

  it("renders an instruction prompt section", () => {
    const prompt = renderSkillsPrompt(2);
    expect(prompt).toContain("prebuilt skills");
    expect(prompt.length).toBeGreaterThan(50);
  });
});
