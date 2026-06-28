import { describe, it, expect } from "vitest";
import {
  computeStability,
  isDemoted,
  structuralFingerprint,
  costCents,
  overDailyCap,
  DAILY_ACTION_CAP,
  DEMOTE_STABILITY,
  type PatchEntry,
} from "../../workers/agents/src/whop/cycle-logic.js";
import { HOST_ACTIONS, PUBLISH_ACTION_NAMES, getHostAction } from "../../workers/agents/src/whop/actions.js";

// Pure-logic verification for the Whop Businesses script engine (no Whop calls).

describe("computeStability", () => {
  it("returns 1.0 for an unproven script", () => {
    expect(computeStability({ success_count: 0, failure_count: 0, patch_history: [] })).toBe(1.0);
  });

  it("falls with failures", () => {
    const s = computeStability({ success_count: 6, failure_count: 4, patch_history: [] });
    expect(s).toBeCloseTo(0.6, 5);
  });

  it("is dampened by recent patches", () => {
    const now = Date.now();
    const patches: PatchEntry[] = [
      { version: 1, reason: "x", timestamp: now - 1000, type: "minor_fix" },
    ];
    const s = computeStability({ success_count: 10, failure_count: 0, patch_history: patches }, now);
    expect(s).toBeCloseTo(0.5, 5); // 1.0 × 1/(1+1)
  });
});

describe("isDemoted (WG-31)", () => {
  const now = Date.now();

  it("does not demote an unproven script", () => {
    expect(isDemoted({ stability_score: 0.1, success_count: 0, failure_count: 0, patch_history: [] }, now)).toBe(false);
  });

  it("demotes a script below the stability floor", () => {
    expect(isDemoted({ stability_score: 0.4, success_count: 4, failure_count: 6, patch_history: [] }, now)).toBe(true);
    expect(DEMOTE_STABILITY).toBe(0.5);
  });

  it("keeps a healthy script in L1 candidacy", () => {
    expect(isDemoted({ stability_score: 0.9, success_count: 9, failure_count: 1, patch_history: [] }, now)).toBe(false);
  });

  it("demotes on frequent recent patches even if stability is ok", () => {
    const patches: PatchEntry[] = [1, 2, 3].map((v) => ({ version: v, reason: "drift", timestamp: now - 1000, type: "minor_fix" }));
    expect(isDemoted({ stability_score: 0.8, success_count: 8, failure_count: 2, patch_history: patches }, now)).toBe(true);
  });
});

describe("structuralFingerprint", () => {
  it("is deterministic and key-order independent", () => {
    const a = structuralFingerprint({ revenue: 1, posts: 2, visibility: "x" });
    const b = structuralFingerprint({ visibility: "y", posts: 99, revenue: 0 }); // same keys, different values
    expect(a).toBe(b);
  });

  it("changes when the key set changes", () => {
    const a = structuralFingerprint({ revenue: 1 });
    const b = structuralFingerprint({ revenue: 1, posts: 2 });
    expect(a).not.toBe(b);
  });
});

describe("overDailyCap (WG-17)", () => {
  it("defers at the cap", () => {
    expect(overDailyCap(DAILY_ACTION_CAP - 1)).toBe(false);
    expect(overDailyCap(DAILY_ACTION_CAP)).toBe(true);
    expect(overDailyCap(DAILY_ACTION_CAP + 1)).toBe(true);
  });
});

describe("costCents (WG-21)", () => {
  it("prices a Haiku call from a usage block", () => {
    // 1M input @ $0.80, 0.5M output @ $4.00 → 80 + 200 = 280 cents
    expect(costCents("claude-haiku-4-5-20251001", 1_000_000, 500_000)).toBeCloseTo(280, 5);
  });

  it("prices an Opus call higher", () => {
    expect(costCents("claude-opus-4-8", 1_000_000, 0)).toBeCloseTo(1500, 5);
  });
});

describe("host-action allow-list (WG-02/WG-07)", () => {
  const SEEDED = [
    "observe_whop_snapshot",
    "post_community_update",
    "check_community_engagement",
    "check_revenue_delta",
    "draft_welcome_post",
    "update_product_visibility",
    "log_cycle_outcome",
  ];

  it("covers every seeded script name", () => {
    for (const name of SEEDED) {
      expect(getHostAction(name), `missing host action: ${name}`).toBeDefined();
    }
  });

  it("exposes exactly the publish actions for the cap counter", () => {
    expect(PUBLISH_ACTION_NAMES).toEqual(["post_community_update"]);
  });

  it("classifies action kinds correctly", () => {
    expect(HOST_ACTIONS["observe_whop_snapshot"]!.kind).toBe("observe");
    expect(HOST_ACTIONS["update_product_visibility"]!.kind).toBe("mutate");
    expect(HOST_ACTIONS["log_cycle_outcome"]!.kind).toBe("internal");
  });

  it("does not resolve an unknown/novel script name (cannot run at L1)", () => {
    expect(getHostAction("draft_some_distilled_thing")).toBeUndefined();
  });
});
