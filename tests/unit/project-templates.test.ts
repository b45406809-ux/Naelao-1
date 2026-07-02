import { describe, it, expect } from "vitest";
import { PROJECT_TEMPLATES, getProjectTemplate, validateProjectTemplates, type ProjectTemplate } from "../../workers/agents/src/launchpad/project-templates.js";

// "User just edits what they want" (no-code) — a template must be a complete, valid,
// SAFE starting point with no required follow-up edits before it's usable. Generalized beyond
// customer_bot: a workspace-kind template (e.g. schedule-driven community monitoring) shares the
// same catalogue and application path, just without the reactive-rules/channel machinery that's
// specific to customer-facing bots.

const CUSTOMER_BOT_TEMPLATES = PROJECT_TEMPLATES.filter((t) => t.kind === "customer_bot");
const WORKSPACE_TEMPLATES = PROJECT_TEMPLATES.filter((t) => t.kind === "workspace");

describe("project templates — catalogue invariants", () => {
  it("every template has a restricted execution ceiling (never the unrestricted default of 5)", () => {
    for (const t of PROJECT_TEMPLATES) {
      expect(t.execution_ceiling).toBeLessThan(5);
      expect(t.execution_ceiling).toBeGreaterThanOrEqual(1);
    }
  });

  it("every template sets a non-zero daily spend cap (no runaway-bill template)", () => {
    for (const t of PROJECT_TEMPLATES) {
      expect(t.daily_spend_cap_credits).toBeGreaterThan(0);
    }
  });

  it("every customer_bot template includes a human-takeover escape hatch (a customer can always reach a person)", () => {
    for (const t of CUSTOMER_BOT_TEMPLATES) {
      expect((t.rules ?? []).some((r) => r.action === "human_takeover")).toBe(true);
    }
  });

  it("every customer_bot template declares a suggested_channel", () => {
    for (const t of CUSTOMER_BOT_TEMPLATES) {
      expect(t.suggested_channel).toBeTruthy();
    }
  });

  it("WhatsApp and email templates include STOP/UNSUBSCRIBE handling (compliance, not optional)", () => {
    const whatsapp = PROJECT_TEMPLATES.find((t) => t.suggested_channel === "whatsapp")!;
    const email = PROJECT_TEMPLATES.find((t) => t.suggested_channel === "email")!;
    for (const t of [whatsapp, email]) {
      expect((t.rules ?? []).some((r) => /stop/i.test(r.trigger_pattern))).toBe(true);
      expect((t.rules ?? []).some((r) => /unsubscribe/i.test(r.trigger_pattern))).toBe(true);
    }
  });

  it("a 'reply' rule always has reply_text and a 'run_script' rule always has script_name", () => {
    for (const t of PROJECT_TEMPLATES) {
      for (const r of t.rules ?? []) {
        if (r.action === "reply") expect(r.reply_text).toBeTruthy();
        if (r.action === "run_script") expect(r.script_name).toBeTruthy();
      }
    }
  });

  it("STOP/unsubscribe and human-takeover rules outrank ordinary canned replies (checked first)", () => {
    for (const t of PROJECT_TEMPLATES) {
      const rules = t.rules ?? [];
      const compliance = rules.filter((r) => r.action === "human_takeover" || /stop|unsubscribe/i.test(r.trigger_pattern));
      const others = rules.filter((r) => !(r.action === "human_takeover" || /stop|unsubscribe/i.test(r.trigger_pattern)));
      if (compliance.length === 0 || others.length === 0) continue;
      const minCompliancePriority = Math.min(...compliance.map((r) => r.priority));
      const maxOtherPriority = Math.max(...others.map((r) => r.priority));
      expect(minCompliancePriority).toBeGreaterThan(maxOtherPriority);
    }
  });

  it("every template id is unique", () => {
    const ids = PROJECT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("when both are set, default_agent_id is always a member of allowed_agent_ids", () => {
    for (const t of PROJECT_TEMPLATES) {
      if (t.default_agent_id && t.allowed_agent_ids && t.allowed_agent_ids.length > 0) {
        expect(t.allowed_agent_ids).toContain(t.default_agent_id);
      }
    }
  });
});

describe("project templates — workspace-kind (schedule/observation-driven)", () => {
  it("has at least one workspace-kind template (the 'community monitoring' scenario)", () => {
    expect(WORKSPACE_TEMPLATES.length).toBeGreaterThan(0);
  });

  it("workspace templates have no suggested_channel (they're not customer-bot projects)", () => {
    for (const t of WORKSPACE_TEMPLATES) {
      expect(t.suggested_channel).toBeUndefined();
    }
  });

  it("community-member-monitoring seeds a default agent binding + a scheduled job", () => {
    const t = getProjectTemplate("community-member-monitoring")!;
    expect(t.kind).toBe("workspace");
    expect(t.default_agent_id).toBeTruthy();
    expect(t.scheduled_jobs?.length).toBeGreaterThan(0);
    expect(t.scheduled_jobs![0]!.cron_expression).toBeTruthy();
  });
});

describe("validateProjectTemplates", () => {
  it("passes for the real catalogue (already asserted at module load, re-asserted here explicitly)", () => {
    expect(() => validateProjectTemplates()).not.toThrow();
  });

  it("rejects a duplicate id", () => {
    const dup: ProjectTemplate = { id: "whatsapp-support-bot", name: "Dup", description: "", kind: "workspace", execution_ceiling: 1, daily_spend_cap_credits: 1 };
    expect(() => validateProjectTemplates([...PROJECT_TEMPLATES, dup])).toThrow(/duplicate id/);
  });

  it("rejects a customer_bot template with no suggested_channel", () => {
    const bad: ProjectTemplate = { id: "x", name: "X", description: "", kind: "customer_bot", execution_ceiling: 2, daily_spend_cap_credits: 100 };
    expect(() => validateProjectTemplates([bad])).toThrow(/requires suggested_channel/);
  });

  it("rejects a zero/negative daily_spend_cap_credits", () => {
    const bad: ProjectTemplate = { id: "x", name: "X", description: "", kind: "workspace", execution_ceiling: 2, daily_spend_cap_credits: 0 };
    expect(() => validateProjectTemplates([bad])).toThrow(/daily_spend_cap_credits/);
  });

  it("rejects default_agent_id excluded from a non-empty allowed_agent_ids", () => {
    const bad: ProjectTemplate = {
      id: "x", name: "X", description: "", kind: "workspace", execution_ceiling: 2, daily_spend_cap_credits: 100,
      default_agent_id: "agent-a", allowed_agent_ids: ["agent-b"],
    };
    expect(() => validateProjectTemplates([bad])).toThrow(/must be included in allowed_agent_ids/);
  });

  it("rejects a 'reply' rule with no reply_text", () => {
    const bad: ProjectTemplate = {
      id: "x", name: "X", description: "", kind: "workspace", execution_ceiling: 2, daily_spend_cap_credits: 100,
      rules: [{ trigger_pattern: "hi", action: "reply", priority: 1 }],
    };
    expect(() => validateProjectTemplates([bad])).toThrow(/requires reply_text/);
  });
});

describe("getProjectTemplate", () => {
  it("returns the matching template by id", () => {
    expect(getProjectTemplate("whatsapp-support-bot")?.suggested_channel).toBe("whatsapp");
  });
  it("returns null for an unknown id (caller 404s, never crashes)", () => {
    expect(getProjectTemplate("does-not-exist")).toBeNull();
  });
});
