import { describe, it, expect } from "vitest";
import { screenNiche } from "../../workers/agents/src/whop/onboarding-guard.js";

// §11/WG-32: out-of-scope niches must be blocked at onboarding, before any Whop
// product is created. Legitimate micro-tools must pass.

describe("screenNiche — blocks out-of-scope niches", () => {
  const blocked = [
    ["Daily Trading Signals", "Premium forex signals every morning"],
    ["Crypto Signal Group", "Join our signal group"],
    ["Sports Betting Picks", "Guaranteed betting tips and parlays"],
    ["VIP Handicapper", "NFL parlay picks"],
    ["Pump and Dump Alerts", "Get in early"],
    ["Wealth Bot", "Guaranteed returns every week"],
  ];

  for (const [name, desc] of blocked) {
    it(`blocks: ${name}`, () => {
      const r = screenNiche(name, desc);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/§11/);
    });
  }

  it("is case-insensitive", () => {
    expect(screenNiche("TRADING SIGNALS", "").allowed).toBe(false);
  });
});

describe("screenNiche — allows legitimate micro-tools", () => {
  const allowed = [
    ["Content Repurposer", "Turn one video into 10 social posts"],
    ["Outreach Autopilot", "Draft and schedule cold emails"],
    ["Niche Research Bot", "Find underserved subreddits for your offer"],
    ["Invoice Generator", "Create branded invoices in seconds"],
  ];

  for (const [name, desc] of allowed) {
    it(`allows: ${name}`, () => {
      expect(screenNiche(name, desc).allowed).toBe(true);
    });
  }

  it("does not over-block the word 'signal' in a benign context", () => {
    // 'signal' alone (not 'signal group' / 'trading signals') should be fine
    expect(screenNiche("Cell Signal Mapper", "Map mobile signal strength by zip").allowed).toBe(true);
  });
});
