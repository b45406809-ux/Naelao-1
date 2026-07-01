import { describe, it, expect } from "vitest";
import { PROJECT_TEMPLATES, getProjectTemplate } from "../../workers/agents/src/launchpad/project-templates.js";

// "User just edits what they want" (no-code) — a template must be a complete, valid,
// SAFE starting point with no required follow-up edits before it's usable.

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

  it("every template includes a human-takeover escape hatch (a customer can always reach a person)", () => {
    for (const t of PROJECT_TEMPLATES) {
      expect(t.rules.some((r) => r.action === "human_takeover")).toBe(true);
    }
  });

  it("WhatsApp and email templates include STOP/UNSUBSCRIBE handling (compliance, not optional)", () => {
    const whatsapp = PROJECT_TEMPLATES.find((t) => t.suggested_channel === "whatsapp")!;
    const email = PROJECT_TEMPLATES.find((t) => t.suggested_channel === "email")!;
    for (const t of [whatsapp, email]) {
      expect(t.rules.some((r) => /stop/i.test(r.trigger_pattern))).toBe(true);
      expect(t.rules.some((r) => /unsubscribe/i.test(r.trigger_pattern))).toBe(true);
    }
  });

  it("a 'reply' rule always has reply_text and a 'run_script' rule always has script_name", () => {
    for (const t of PROJECT_TEMPLATES) {
      for (const r of t.rules) {
        if (r.action === "reply") expect(r.reply_text).toBeTruthy();
        if (r.action === "run_script") expect(r.script_name).toBeTruthy();
      }
    }
  });

  it("STOP/unsubscribe and human-takeover rules outrank ordinary canned replies (checked first)", () => {
    for (const t of PROJECT_TEMPLATES) {
      const compliance = t.rules.filter((r) => r.action === "human_takeover" || /stop|unsubscribe/i.test(r.trigger_pattern));
      const others = t.rules.filter((r) => !(r.action === "human_takeover" || /stop|unsubscribe/i.test(r.trigger_pattern)));
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
});

describe("getProjectTemplate", () => {
  it("returns the matching template by id", () => {
    expect(getProjectTemplate("whatsapp-support-bot")?.suggested_channel).toBe("whatsapp");
  });
  it("returns null for an unknown id (caller 404s, never crashes)", () => {
    expect(getProjectTemplate("does-not-exist")).toBeNull();
  });
});
