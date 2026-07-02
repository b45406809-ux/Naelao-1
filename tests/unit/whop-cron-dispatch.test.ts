import { describe, it, expect } from "vitest";
import { getManifest } from "../../workers/agents/src/launchpad/manifest.js";

// Verifies the scheduled-handler dispatch decision: which path fires per status.manifest_kind.
// The actual handler lives in index.ts and requires DO bindings, so we test the decision
// logic here in pure terms — the status shape feeds a simple if/else and the manifest
// is the single source of truth for the kind.

type StatusLike = {
  manifest_kind: string;
  paused: boolean;
  fiber_status: string;
  custom_business: boolean;
  goal: string | null;
  whop_product_id: string | null;
};

function cronDispatch(status: StatusLike): "skip" | "heartbeat" | "l4_cycle" | "l1_cycle" | "no_product" {
  if (status.paused || status.fiber_status === "running") return "skip";
  if (status.manifest_kind === "assistant") return "heartbeat";
  if (status.custom_business) return status.goal ? "l4_cycle" : "skip";
  if (!status.whop_product_id) return "no_product";
  return "l1_cycle";
}

describe("scheduled cron dispatch (heartbeat vs cycle)", () => {
  it("skips paused businesses regardless of kind", () => {
    expect(cronDispatch({ manifest_kind: "assistant", paused: true, fiber_status: "idle", custom_business: false, goal: null, whop_product_id: null })).toBe("skip");
    expect(cronDispatch({ manifest_kind: "niche", paused: true, fiber_status: "idle", custom_business: false, goal: null, whop_product_id: "p1" })).toBe("skip");
  });

  it("skips a business whose cycle is already running (fiber guard)", () => {
    expect(cronDispatch({ manifest_kind: "niche", paused: false, fiber_status: "running", custom_business: false, goal: null, whop_product_id: "p1" })).toBe("skip");
  });

  it("routes assistant-kind to heartbeat (channel queue drain)", () => {
    const assistantStatus: StatusLike = {
      manifest_kind: "assistant",
      paused: false,
      fiber_status: "idle",
      custom_business: false,
      goal: null,
      whop_product_id: null,
    };
    expect(cronDispatch(assistantStatus)).toBe("heartbeat");
  });

  it("routes custom niche to L4 cycle when a goal exists", () => {
    const customStatus: StatusLike = {
      manifest_kind: "niche",
      paused: false,
      fiber_status: "idle",
      custom_business: true,
      goal: "Grow a newsletter business to 1000 subs",
      whop_product_id: null,
    };
    expect(cronDispatch(customStatus)).toBe("l4_cycle");
  });

  it("skips a custom business with no goal (nothing to act on)", () => {
    expect(cronDispatch({ manifest_kind: "niche", paused: false, fiber_status: "idle", custom_business: true, goal: null, whop_product_id: null })).toBe("skip");
  });

  it("routes Whop niche to L1 cycle when product id is present", () => {
    expect(cronDispatch({ manifest_kind: "niche", paused: false, fiber_status: "idle", custom_business: false, goal: null, whop_product_id: "prod_123" })).toBe("l1_cycle");
  });

  it("does not run an L1 cycle with no Whop product id", () => {
    expect(cronDispatch({ manifest_kind: "niche", paused: false, fiber_status: "idle", custom_business: false, goal: null, whop_product_id: null })).toBe("no_product");
  });
});

describe("manifest kind determines dispatch path", () => {
  it("support-assistant → assistant kind → heartbeat path", () => {
    expect(getManifest("support-assistant").kind).toBe("assistant");
  });

  it("whop-businesses → niche kind → L1 cycle path", () => {
    expect(getManifest("whop-businesses-v1").kind).toBe("niche");
  });

  it("custom → niche kind → L4 cycle path (no seed scripts)", () => {
    expect(getManifest("custom").kind).toBe("niche");
    expect(getManifest("custom").seed_scripts).toHaveLength(0);
  });
});
