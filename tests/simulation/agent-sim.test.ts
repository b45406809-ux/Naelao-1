import { describe, it, expect } from "vitest";
import {
  simulateContentCycle,
  simulateToolBuildDeploy,
  simulateOnboardingScreen,
  simulateCustomOnboarding,
  mockGenerate,
  type GenScenario,
} from "./agent-sim.js";

// Error-sweep: drive the real production decision logic with simulated model output
// across every failure mode. A green run means the agent degrades safely — it never
// publishes unsafe/garbage content, never deploys an untested tool, never crashes.

describe("content cycle — simulated generations route safely", () => {
  it("publishes a valid post at Tier 2 under the cap", () => {
    expect(simulateContentCycle("valid", { tier: 2, publishCountLast24h: 0 }).decision).toBe("publish");
  });

  it("never auto-publishes at Tier 1 (drafts for approval)", () => {
    for (const s of ["valid", "benign_signal_word"] as GenScenario[]) {
      expect(simulateContentCycle(s, { tier: 1, publishCountLast24h: 0 }).decision).toBe("draft_for_approval");
    }
  });

  it("blocks prompt-injection content (does NOT publish)", () => {
    const r = simulateContentCycle("injection", { tier: 2, publishCountLast24h: 0 });
    expect(r.decision).toBe("blocked_moderation");
  });

  it("blocks policy-violating content", () => {
    expect(simulateContentCycle("policy_violation", { tier: 2, publishCountLast24h: 0 }).decision).toBe("blocked_moderation");
  });

  it("treats an empty generation as a failure, not a publish", () => {
    expect(simulateContentCycle("empty", { tier: 2, publishCountLast24h: 0 }).decision).toBe("generation_failed");
  });

  it("truncates oversized output and still decides safely", () => {
    const r = simulateContentCycle("oversized", { tier: 2, publishCountLast24h: 0 });
    expect(r.content.length).toBeLessThanOrEqual(4000);
    expect(["publish", "blocked_moderation"]).toContain(r.decision);
  });

  it("defers when over the daily cap even for valid content", () => {
    expect(simulateContentCycle("valid", { tier: 2, publishCountLast24h: 99 }).decision).toBe("deferred_cap");
  });
});

describe("tool build/deploy — the §02 gate holds under simulated builds", () => {
  it("deploys a tool that builds AND passes tests", () => {
    const r = simulateToolBuildDeploy({ built: true, tests_passed: true });
    expect(r.deployed).toBe(true);
    expect(r.finalState).toBe("live");
  });

  it("NEVER deploys a tool whose tests fail", () => {
    const r = simulateToolBuildDeploy({ built: true, tests_passed: false });
    expect(r.deployed).toBe(false);
    expect(r.finalState).toBe("build_failed");
  });

  it("NEVER deploys a tool that fails to build", () => {
    const r = simulateToolBuildDeploy({ built: false, tests_passed: false });
    expect(r.deployed).toBe(false);
  });
});

describe("onboarding screen — blocks out-of-scope niches before a product exists", () => {
  it("blocks trading-signal / betting niches", () => {
    expect(simulateOnboardingScreen("Daily Trading Signals", "forex signals")).toBe(false);
    expect(simulateOnboardingScreen("Betting Picks", "guaranteed parlays")).toBe(false);
  });

  it("allows a legitimate micro-tool", () => {
    expect(simulateOnboardingScreen("Outreach Autopilot", "draft and schedule cold emails")).toBe(true);
  });
});

describe("custom business path — safety floor holds even with no template", () => {
  it("blocks a dangerous custom business the niche guard wouldn't catch", () => {
    // A custom goal skips the Whop niche guard, but the floor still blocks it.
    expect(simulateCustomOnboarding("Run a sports betting tips business with guaranteed returns")).toBe(false);
    expect(simulateCustomOnboarding("Give personalized investment advice and stock tips")).toBe(false);
  });

  it("allows a legitimate custom business", () => {
    expect(simulateCustomOnboarding("Run a newsletter business about indie game development")).toBe(true);
  });
});

describe("harness sanity — every scenario produces a deterministic generation", () => {
  it("mockGenerate is total over scenarios", () => {
    for (const s of ["valid", "empty", "oversized", "injection", "policy_violation", "benign_signal_word"] as GenScenario[]) {
      expect(typeof mockGenerate(s)).toBe("string");
    }
  });
});
