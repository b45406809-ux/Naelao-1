import { describe, it, expect } from "vitest";
import { PROJECT_TEMPLATES, getProjectTemplate, validateProjectTemplates, type ProjectTemplate } from "../../workers/agents/src/launchpad/project-templates.js";

describe("project templates — generic project presets", () => {
  it("contains no provider-specific customer bot presets", () => {
    for (const id of ["whatsapp-support-bot", "discord-community-bot", "email-support-bot"]) {
      expect(getProjectTemplate(id)).toBeNull();
    }
  });

  it("keeps the remaining presets within their execution and spend limits", () => {
    for (const template of PROJECT_TEMPLATES) {
      expect(template.execution_ceiling).toBeGreaterThanOrEqual(1);
      expect(template.execution_ceiling).toBeLessThan(5);
      expect(template.daily_spend_cap_credits).toBeGreaterThan(0);
    }
  });

  it("keeps community monitoring as a generic scheduled workspace preset", () => {
    const template = getProjectTemplate("community-member-monitoring");
    expect(template?.default_agent_id).toBeTruthy();
    expect(template?.suggested_channel).toBeUndefined();
    expect(template?.scheduled_jobs?.[0]?.cron_expression).toBeTruthy();
  });
});

describe("validateProjectTemplates", () => {
  it("accepts the catalogue and rejects duplicate ids", () => {
    expect(() => validateProjectTemplates()).not.toThrow();
    const duplicate: ProjectTemplate = { ...PROJECT_TEMPLATES[0]!, name: "Duplicate" };
    expect(() => validateProjectTemplates([...PROJECT_TEMPLATES, duplicate])).toThrow(/duplicate id/);
  });

  it("rejects a zero daily spend cap and incomplete reply rules", () => {
    const badCap: ProjectTemplate = { id: "bad_cap", name: "Bad cap", description: "", execution_ceiling: 2, daily_spend_cap_credits: 0 };
    expect(() => validateProjectTemplates([badCap])).toThrow(/daily_spend_cap_credits/);
    const badRule: ProjectTemplate = { ...badCap, id: "bad_rule", daily_spend_cap_credits: 100, rules: [{ trigger_pattern: "hi", action: "reply", priority: 1 }] };
    expect(() => validateProjectTemplates([badRule])).toThrow(/requires reply_text/);
  });
});
