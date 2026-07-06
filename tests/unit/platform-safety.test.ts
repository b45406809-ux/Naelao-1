import { describe, it, expect } from "vitest";
import { safetyFloor } from "../../workers/agents/src/safety.js";

// The template-agnostic safety floor — the prerequisite for ANY custom/no-template
// path. It must block dangerous & regulated categories regardless of how the request
// arrived (official template OR custom Level-4 goal).

describe("safetyFloor — blocks dangerous & regulated categories", () => {
  const blocked: Array<[string, string]> = [
    ["A service giving stock tips and trading signals", "financial_advice"],
    ["Sports betting picks and parlays community", "gambling"],
    ["An app that gives medical advice and diagnoses", "regulated_profession"],
    ["Marketplace for firearms and ammunition", "controlled_goods"],
    ["Guaranteed returns, get rich quick, risk-free profit", "scam_or_guarantee"],
  ];

  for (const [text, cat] of blocked) {
    it(`blocks ${cat}: "${text.slice(0, 30)}…"`, () => {
      const r = safetyFloor(text);
      expect(r.allowed).toBe(false);
      expect(r.category).toBe(cat);
    });
  }

  it("is case-insensitive", () => {
    expect(safetyFloor("TRADING SIGNALS for everyone").allowed).toBe(false);
  });

  it("allows legitimate businesses (the floor is narrow, not a blanket block)", () => {
    for (const t of [
      "A content repurposing tool with a community",
      "Cold outreach automation for agencies",
      "A niche research bot for ecommerce sellers",
      "Invoice generator for freelancers",
    ]) {
      expect(safetyFloor(t).allowed, t).toBe(true);
    }
  });
});
