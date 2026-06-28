import { describe, it, expect } from "vitest";
import { devCatalog, productCatalog, liveNiche, SPACE_TYPES, TEMPLATES, PRODUCT_NICHES } from "../../workers/agents/src/catalog.js";
import { canAccessBusiness } from "../../workers/agents/src/access.js";

// The three-tier roadmap surface: one niche live, everything else "coming soon".

describe("catalog — exactly one live niche, rest coming soon", () => {
  it("Launchpad is the only live space type", () => {
    const live = SPACE_TYPES.filter(s => s.status === "live");
    expect(live.map(s => s.id)).toEqual(["launchpad"]);
    expect(SPACE_TYPES.length).toBeGreaterThan(1); // others present as coming_soon
  });

  it("Whop Businesses is the only live template", () => {
    expect(TEMPLATES.filter(t => t.status === "live").map(t => t.id)).toEqual(["whop-businesses"]);
  });

  it("the official Whop template and custom are live; other niches are coming_soon", () => {
    const liveIds = PRODUCT_NICHES.filter(n => n.status === "live").map(n => n.id);
    expect(liveIds).toContain("ai-microtool-community");
    expect(liveIds).toContain("custom");
    expect(liveNiche().id).toBe("ai-microtool-community"); // primary live niche
    expect(PRODUCT_NICHES.every(n => n.status === "live" || n.status === "coming_soon")).toBe(true);
  });

  it("productCatalog reports correct counts", () => {
    const cat = productCatalog();
    const live = PRODUCT_NICHES.filter(n => n.status === "live").length;
    expect(cat.live_count).toBe(live);
    expect(cat.coming_soon_count).toBe(PRODUCT_NICHES.length - live);
  });

  it("devCatalog exposes both space types and templates", () => {
    const cat = devCatalog();
    expect(cat.space_types.length).toBe(SPACE_TYPES.length);
    expect(cat.templates.length).toBe(TEMPLATES.length);
  });
});

describe("canAccessBusiness — tenant isolation at the API layer", () => {
  it("a user may access their own business", () => {
    expect(canAccessBusiness("user-1", "member", "user-1")).toBe(true);
  });

  it("a user may NOT access another user's business", () => {
    expect(canAccessBusiness("user-1", "member", "user-2")).toBe(false);
    expect(canAccessBusiness("user-1", "viewer", "user-2")).toBe(false);
  });

  it("the founder (admin/owner) may access any business — dev access", () => {
    expect(canAccessBusiness("founder", "admin", "user-2")).toBe(true);
    expect(canAccessBusiness("founder", "owner", "anyone")).toBe(true);
  });

  it("internal calls without identity pass through (router not in front)", () => {
    expect(canAccessBusiness("", "", "user-2")).toBe(true);
  });
});
