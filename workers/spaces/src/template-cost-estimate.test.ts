import { describe, expect, it } from "vitest";
import { loadTemplateCostEstimate, selectedTemplateListingId, validateTemplateExpectedUsage } from "./template-cost-estimate.js";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const RATE_VALID_UNTIL = "2026-12-13T00:00:00.000Z";

function sqliteCostDb(planTier = "business") {
  const db = createFakeD1([
    "CREATE TABLE orgs(id TEXT PRIMARY KEY, plan_tier TEXT NOT NULL, status TEXT NOT NULL)",
    "CREATE TABLE managed_service_capability_versions(provider TEXT, service_id TEXT, version INTEGER, operations_json TEXT, regions_json TEXT, account_modes_json TEXT, status TEXT, valid_until TEXT, PRIMARY KEY(provider, service_id, version))",
    "CREATE TABLE managed_service_model_entitlements(plan_tier TEXT, provider TEXT, service_id TEXT, capability_version INTEGER, operation_name TEXT, model_id TEXT, region TEXT, price_version TEXT, credits_per_operation INTEGER, max_credits_per_operation INTEGER, max_output_tokens INTEGER, max_operations_per_period INTEGER, status TEXT, verified_by TEXT, verified_at TEXT, valid_until TEXT)",
    "CREATE TABLE marketplace_forks(tenant_id TEXT, blueprint_id TEXT, listing_id TEXT)",
    "CREATE TABLE marketplace_listings(id TEXT, pricing_model TEXT, price_cents INTEGER, status TEXT)",
    "CREATE TABLE marketplace_license_purchases(tenant_id TEXT, listing_id TEXT, amount_cents INTEGER, created_at TEXT)",
  ]);
  db.db.prepare("INSERT INTO orgs VALUES('tenant-a', ?, 'active')").run(planTier);
  db.db.prepare(`INSERT INTO managed_service_capability_versions VALUES
    ('cloudflare','workers-ai',1,'["generate-text"]','["global"]','["naelao_managed"]','verified',?)`).run(RATE_VALID_UNTIL);
  db.db.prepare(`INSERT INTO managed_service_model_entitlements VALUES
    (?, 'cloudflare','workers-ai',1,'generate-text',?,'global','cf-model-fixed-v3',55,100,768,3000,'active','operator-1','2026-11-01T00:00:00.000Z',?)`)
    .run(planTier, MODEL, RATE_VALID_UNTIL);
  db.db.prepare("INSERT INTO marketplace_forks VALUES('tenant-a','blueprint-a','listing-a')").run();
  db.db.prepare("INSERT INTO marketplace_listings VALUES('listing-a','fixed_license',0,'published')").run();
  return db;
}

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

  it("validates customer-entered usage assumptions and reports projected volume without inventing rates", async () => {
    const usage = validateTemplateExpectedUsage({ conversations_per_month: 200, interactions_per_conversation: 8 });
    expect(() => validateTemplateExpectedUsage({ conversations_per_month: 0, interactions_per_conversation: 8 })).toThrow("expected_usage_invalid");
    expect(() => validateTemplateExpectedUsage({ conversations_per_month: 200, interactions_per_conversation: 8, total_cents: 0 })).toThrow("expected_usage_invalid");
    const estimate = await loadTemplateCostEstimate({ prepare() { return { bind() { return { first: async () => ({
      pricing_model: "fixed_license", price_cents: 0, amount_cents: null, created_at: null,
    }) }; } }; } }, "tenant-a", "blueprint-a", "listing-a", new Date("2026-11-13T00:00:00.000Z"), usage);
    expect(estimate).toMatchObject({ total_estimate_cents: null, expected_monthly_usage: {
      basis: "customer_entered_assumption", conversations: 200, interactions_per_conversation: 8,
      projected_interactions: 1600, estimated_cost_cents: null,
    } });
  });

  it("projects only the exact current verified model-credit price and plan limit from SQLite", async () => {
    const db = sqliteCostDb();
    const usage = validateTemplateExpectedUsage({ conversations_per_month: 200, interactions_per_conversation: 8,
      managed_model_id: MODEL, model_calls_per_interaction: 2, model_credits_budget_per_month: 200000 });
    const estimate = await loadTemplateCostEstimate(db, "tenant-a", "blueprint-a", "listing-a",
      new Date("2026-11-13T00:00:00.000Z"), usage);
    expect(estimate).toMatchObject({
      total_estimate_cents: null,
      managed_model_catalog_status: "available",
      available_managed_models: [{ model_id: MODEL, price_version: "cf-model-fixed-v3", credits_per_operation: 55,
        max_operations_per_period: 3000, valid_until: RATE_VALID_UNTIL }],
      expected_monthly_usage: { projected_interactions: 1600, model_id: MODEL, model_calls_per_interaction: 2,
        model_credits_budget_per_month: 200000, estimated_cost_cents: null },
      managed_model_scenario: { status: "estimated", basis: "customer_entered_operation_assumption", model_id: MODEL,
        price_version: "cf-model-fixed-v3", credit_unit: "naelao_credit", operations_per_month: 3200,
        credits_per_operation: 55, projected_credits: 176000, max_operations_per_period: 3000,
        within_plan_operation_limit: false, rate_valid_until: RATE_VALID_UNTIL,
        customer_budget_comparison: { basis: "customer_entered_planning_assumption", credits_per_month: 200000,
          within_projected_credits: true, enforcement: "not_enforced" } },
    });
    const belowBudget = await loadTemplateCostEstimate(db, "tenant-a", "blueprint-a", "listing-a",
      new Date("2026-11-13T00:00:00.000Z"), { ...usage, model_credits_budget_per_month: 100000 });
    expect(belowBudget.managed_model_scenario?.customer_budget_comparison).toMatchObject({ credits_per_month: 100000,
      within_projected_credits: false, enforcement: "not_enforced" });
    expect(estimate.not_estimated).toContain("direct provider costs for managed-model inference and other services");
    expect(estimate.not_estimated).toContain("taxes, regional pricing, and account-specific provider terms");
    db.db.close();
  });

  it("returns an unavailable scenario for an unentitled model and rejects malformed multipliers", async () => {
    expect(() => validateTemplateExpectedUsage({ conversations_per_month: 4, interactions_per_conversation: 3,
      managed_model_id: MODEL })).toThrow("expected_usage_invalid");
    expect(() => validateTemplateExpectedUsage({ conversations_per_month: 4, interactions_per_conversation: 3,
      model_calls_per_interaction: 2 })).toThrow("expected_usage_invalid");
    expect(() => validateTemplateExpectedUsage({ conversations_per_month: 4, interactions_per_conversation: 3,
      model_credits_budget_per_month: 500 })).toThrow("expected_usage_invalid");
    expect(() => validateTemplateExpectedUsage({ conversations_per_month: 4, interactions_per_conversation: 3,
      managed_model_id: MODEL, model_calls_per_interaction: 1, model_credits_budget_per_month: 0 })).toThrow("expected_usage_invalid");
    const db = sqliteCostDb();
    const estimate = await loadTemplateCostEstimate(db, "tenant-a", "blueprint-a", "listing-a",
      new Date("2026-11-13T00:00:00.000Z"), { conversations_per_month: 4, interactions_per_conversation: 3,
        managed_model_id: "unentitled-model", model_calls_per_interaction: 1, model_credits_budget_per_month: 500 });
    expect(estimate.managed_model_scenario).toMatchObject({ status: "unavailable", model_id: "unentitled-model",
      reason: "active_model_entitlement_unavailable", operations_per_month: 12,
      customer_budget_comparison: { credits_per_month: 500, within_projected_credits: null, enforcement: "not_enforced" } });
    db.db.close();
  });

  it("does not fall back to an older verified manifest or emit unsafe credit products", async () => {
    const db = sqliteCostDb();
    db.db.prepare(`INSERT INTO managed_service_capability_versions VALUES
      ('cloudflare','workers-ai',2,'["generate-text"]','["global"]','["naelao_managed"]','draft',?)`).run(RATE_VALID_UNTIL);
    const newerDraft = await loadTemplateCostEstimate(db, "tenant-a", "blueprint-a", "listing-a",
      new Date("2026-11-13T00:00:00.000Z"), { conversations_per_month: 4, interactions_per_conversation: 3,
        managed_model_id: MODEL, model_calls_per_interaction: 1 });
    expect(newerDraft.available_managed_models).toEqual([]);
    expect(newerDraft.managed_model_scenario).toMatchObject({ status: "unavailable", reason: "active_model_entitlement_unavailable" });
    db.db.close();

    const largeDb = sqliteCostDb();
    largeDb.db.prepare("UPDATE managed_service_model_entitlements SET credits_per_operation=2000000000, max_credits_per_operation=2000000000").run();
    const tooLarge = await loadTemplateCostEstimate(largeDb, "tenant-a", "blueprint-a", "listing-a",
      new Date("2026-11-13T00:00:00.000Z"), { conversations_per_month: 1_000_000, interactions_per_conversation: 500,
        managed_model_id: MODEL, model_calls_per_interaction: 10 });
    expect(tooLarge.managed_model_scenario).toMatchObject({ status: "unavailable", reason: "projection_out_of_range",
      operations_per_month: 5_000_000_000 });
    largeDb.db.close();
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
