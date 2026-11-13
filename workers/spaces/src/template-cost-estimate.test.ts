import { describe, expect, it } from "vitest";
import { loadTemplateCostEstimate, selectedTemplateListingId } from "./template-cost-estimate.js";

describe("guided template cost disclosure", () => {
  it("preserves an exact selected listing identity in the Space configuration", () => {
    expect(selectedTemplateListingId(JSON.stringify({ template_listing_id: "listing-a" })))
      .toEqual({ kind: "selected", listingId: "listing-a" });
    expect(selectedTemplateListingId("{}")).toEqual({ kind: "legacy" });
    expect(selectedTemplateListingId(JSON.stringify({ template_listing_id: "../other" })))
      .toEqual({ kind: "invalid" });
    expect(selectedTemplateListingId("not-json")).toEqual({ kind: "invalid" });
  });

  it("reports a recorded paid template license as already paid without pretending to total future usage", async () => {
    let query = "";
    let values: unknown[] = [];
    const estimate = await loadTemplateCostEstimate({ prepare(sql) {
      query = sql;
      return { bind(...args) { values = args; return { first: async () => ({
        pricing_model: "fixed_license", price_cents: 2500, amount_cents: 2500, created_at: "2026-11-01T00:00:00.000Z",
      }) }; } };
    } }, "tenant-a", "blueprint-a", "listing-a", new Date("2026-11-13T00:00:00.000Z"));

    expect(query).toContain("marketplace_license_purchases");
    expect(values).toEqual(["tenant-a", "blueprint-a", "listing-a"]);
    expect(estimate).toMatchObject({ status: "partial", total_estimate_cents: null,
      known_one_time_costs: [{ amount_cents: 2500, basis: "recorded_purchase", already_paid: true,
        paid_at: "2026-11-01T00:00:00.000Z" }] });
    expect(estimate.not_estimated).toContain("channel and external provider charges, including phone numbers and email");
  });

  it("reports a zero-price listing separately from unknown operating costs", async () => {
    const estimate = await loadTemplateCostEstimate({ prepare() { return { bind() { return { first: async () => ({
      pricing_model: "freemium_tiered", price_cents: 0, amount_cents: null, created_at: null,
    }) }; } }; } }, "tenant-a", "blueprint-a", "listing-a", new Date("2026-11-13T00:00:00.000Z"));

    expect(estimate).toMatchObject({ status: "partial", total_estimate_cents: null,
      known_one_time_costs: [{ amount_cents: 0, basis: "current_zero_price_listing", already_paid: false }] });
  });

  it("does not infer a price when legacy installation metadata or listing evidence is missing", async () => {
    const missingSelection = await loadTemplateCostEstimate({ prepare() { throw new Error("should not query"); } },
      "tenant-a", "blueprint-a", null, new Date("2026-11-13T00:00:00.000Z"));
    const missingListing = await loadTemplateCostEstimate({ prepare() { return { bind() { return { first: async () => null }; } }; } },
      "tenant-a", "blueprint-a", "listing-a", new Date("2026-11-13T00:00:00.000Z"));
    expect(missingSelection).toMatchObject({ status: "unavailable", reason: "selected_listing_not_recorded", known_one_time_costs: [] });
    expect(missingListing).toMatchObject({ status: "unavailable", reason: "listing_price_unavailable", known_one_time_costs: [] });
  });
});
