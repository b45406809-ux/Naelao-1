import { describe, expect, it } from "vitest";
import { presentAutonomyPolicy } from "./autonomy-policy.js";

describe("presentAutonomyPolicy", () => {
  it("uses the safe ask-first default for missing or empty policy", () => {
    expect(presentAutonomyPolicy(null).level).toBe("ask_first");
    expect(presentAutonomyPolicy({ approval_mode: "always_ask", auto_approved_actions: [] })).toMatchObject({
      level: "ask_first",
      label: "Ask before acting",
    });
  });

  it("explains an explicit action allowlist without overstating autonomy", () => {
    expect(presentAutonomyPolicy({ approval_mode: "always_ask", auto_approved_actions: ["knowledge.search"] })).toMatchObject({
      level: "approved_actions",
      label: "Run approved actions; ask for others",
    });
  });

  it("shows autonomous mode as bounded by server grants and limits", () => {
    expect(presentAutonomyPolicy({ approval_mode: "yolo", auto_approved_actions: [] })).toMatchObject({
      level: "run_within_limits",
      label: "Run within grants and limits",
    });
    expect(presentAutonomyPolicy({ approval_mode: "yolo", auto_approved_actions: [] }).explanation).toContain("verified role");
  });

  it("preserves legacy custom gate modes as a distinct display state", () => {
    expect(presentAutonomyPolicy({ approval_mode: "gate_listed", auto_approved_actions: ["payment.send"] }).level).toBe("custom");
    expect(presentAutonomyPolicy({ approval_mode: "gate_unless_listed", auto_approved_actions: ["knowledge.search"] }).level).toBe("approved_actions");
  });
});
