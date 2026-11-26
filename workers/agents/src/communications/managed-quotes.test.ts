import { describe, expect, it } from "vitest";
import type { AgentsEnv } from "../index.js";
import { createManagedAgentMailQuote } from "./agentmail.js";
import { ensureIdentity } from "./core.js";
import { computeQuoteBreakdown, configurationSha256, createOfferingQuote, offeringPriceVersion, parseChargeComponents, verifyOfferingQuote,
  ManagedQuoteError, type OfferingQuoteInput } from "./managed-quotes.js";
import { enableManagedOfferingsFixture, fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";

const NOW = new Date("2026-12-01T00:00:00Z");
const EMAIL_COMPONENTS = [
  { kind: "setup", credits: 20 },
  { kind: "rental", interval: "month", credits: 100, included_sends: 1000 },
  { kind: "usage", meter: "email.message.sent", included: 1000, unit_credits_per: { qty: 1000, credits: 10 } },
  { kind: "storage", meter: "email.storage.gb_month", unit_credits_per: { qty: 1, credits: 5 }, included: 0 },
];
const q = (sql: string, ...args: unknown[]) => (f: ReturnType<typeof fixture>) => f.db.db.prepare(sql).get(...(args as never[])) as Record<string, unknown>;

function offeringsHarness(components: unknown[] = EMAIL_COMPONENTS) {
  const f = fixture();
  enableManagedOfferingsFixture(f.db, f.env, { agentmail: components });
  f.db.db.prepare(`UPDATE managed_service_capability_versions SET status='verified',verified_by='op',verified_at='2026-11-01T00:00:00Z',valid_until='2099-01-01T00:00:00.000Z',regions_json='["us"]'
    WHERE provider='agentmail' AND service_id='agentmail' AND version=1`).run();
  const input = (over: Partial<OfferingQuoteInput> = {}): OfferingQuoteInput => ({
    scope: { tenantId: "tenant", spaceId: "space", projectId: null, userId: "user" }, planTier: "free", provider: "agentmail", serviceId: "agentmail",
    operationName: "provision", region: "us", configuration: { display: "A", domain: "mail.test" }, now: NOW, ...over });
  return { f, input, env: f.env as unknown as AgentsEnv };
}

describe("MS-37 charge components", () => {
  it("lists every component and the minimum monthly cost", () => {
    const b = computeQuoteBreakdown(parseChargeComponents(EMAIL_COMPONENTS));
    expect(b.components).toHaveLength(4);
    expect(b.mandatory.map((c) => c.kind)).toEqual(["setup", "rental"]);
    expect(b.minMonthlyCredits).toBe(100);
    expect(b.setupCredits).toBe(20);
    expect(b.initialCredits).toBe(120);
  });
  it("normalises a yearly rental up to a month and rejects malformed components", () => {
    expect(computeQuoteBreakdown(parseChargeComponents([{ kind: "rental", interval: "year", credits: 1000 }])).minMonthlyCredits).toBe(84);
    for (const bad of [{ kind: "mystery" }, { kind: "rental", interval: "week", credits: 1 }, { kind: "setup", credits: -1 },
      { kind: "usage", meter: "x", included: 0, unit_credits_per: { qty: 0, credits: 1 } }, "x"]) {
      expect(() => parseChargeComponents([bad])).toThrow("quote_components_invalid");
    }
    expect(() => parseChargeComponents({})).toThrow("quote_components_invalid");
  });
  it("hashes configuration independent of key order", async () => {
    expect(await configurationSha256({ a: 1, b: { c: 2, d: 3 } })).toBe(await configurationSha256({ b: { d: 3, c: 2 }, a: 1 }));
    expect(await configurationSha256({ a: 1 })).not.toBe(await configurationSha256({ a: 2 }));
  });
});

describe("MS-37 offering-driven quote creator", () => {
  it("stores every component, minimum monthly cost and bindings", async () => {
    const h = offeringsHarness();
    const quote = await createOfferingQuote(h.env, h.input());
    expect(quote.components).toHaveLength(4);
    expect(quote.minMonthlyCredits).toBe(100);
    expect(quote.credits).toBe(120);
    const row = q("SELECT * FROM managed_service_operation_quotes WHERE quote_id=?", quote.quoteId)(h.f);
    expect(row).toMatchObject({ tenant_id: "tenant", offering_id: "offering-agentmail-agentmail", region: "us", status: "quoted", credits: 120,
      min_monthly_credits: 100, price_version: quote.priceVersion, configuration_sha256: await configurationSha256({ display: "A", domain: "mail.test" }) });
    expect(JSON.parse(row.charge_components_json as string)).toHaveLength(4);
    expect(Date.parse(row.expires_at as string) - NOW.getTime()).toBe(15 * 60_000);
  });
  it("refuses a lifetime over 15 minutes, in code and in the table", async () => {
    const h = offeringsHarness();
    await expect(createOfferingQuote(h.env, h.input({ ttlMs: 15 * 60_000 + 1 }))).rejects.toThrow("quote_ttl_invalid");
    expect(() => h.f.db.db.prepare(`INSERT INTO managed_service_operation_quotes(quote_id,tenant_id,space_id,requester_user_id,plan_tier,provider,service_id,operation_name,
      region,capability_version,price_version,credits,status,expires_at,created_at,offering_id) VALUES('msq_x','t','s','u','free','agentmail','agentmail','provision','us',1,'v',1,'quoted',
      '2026-12-01T00:16:00.000Z','2026-12-01T00:00:00.000Z','offering-agentmail-agentmail')`).run()).toThrow(/expiry_too_long/);
  });
  it("fails closed when admission refuses and when the offering has no charge", async () => {
    const h = offeringsHarness();
    h.f.db.db.prepare("UPDATE managed_service_offerings SET status='disabled'").run();
    await expect(createOfferingQuote(h.env, h.input())).rejects.toMatchObject({ code: "offering_unavailable" });
    const free = offeringsHarness([]);
    await expect(createOfferingQuote(free.env, free.input())).rejects.toThrow(ManagedQuoteError);
    await expect(createOfferingQuote(free.env, free.input())).rejects.toMatchObject({ code: "quote_no_charge" });
    const bad = offeringsHarness([{ kind: "mystery" }]);
    await expect(createOfferingQuote(bad.env, bad.input())).rejects.toMatchObject({ code: "quote_components_invalid" });
  });
  it("uses a caller-supplied entitlement price but still snapshots the components", async () => {
    const h = offeringsHarness();
    const quote = await createOfferingQuote(h.env, h.input({ priceOverride: { credits: 300, priceVersion: "agentmail-rental-v2", capabilityVersion: 1 } }));
    expect(quote).toMatchObject({ credits: 300, priceVersion: "agentmail-rental-v2", minMonthlyCredits: 100 });
  });
});

describe("MS-37 quote verification (MR-COM-7/8)", () => {
  async function setup() {
    const h = offeringsHarness();
    const config = { display: "A", domain: "mail.test" };
    const quote = await createOfferingQuote(h.env, h.input({ configuration: config }));
    const expect_ = { tenantId: "tenant", offeringId: quote.offeringId, region: "us", configuration: config, priceVersion: quote.priceVersion, now: new Date(NOW.getTime() + 60_000) };
    return { h, quote, expect_ };
  }
  it("accepts a matching, live quote", async () => {
    const { h, quote, expect_ } = await setup();
    expect(await verifyOfferingQuote(h.env, quote.quoteId, expect_)).toMatchObject({ ok: true, credits: 120 });
  });
  it("returns quote_expired after the expiry", async () => {
    const { h, quote, expect_ } = await setup();
    expect(await verifyOfferingQuote(h.env, quote.quoteId, { ...expect_, now: new Date(NOW.getTime() + 15 * 60_000) })).toEqual({ ok: false, error_code: "quote_expired" });
  });
  it("needs a new quote when the price changed", async () => {
    const { h, quote, expect_ } = await setup();
    const raised = parseChargeComponents(EMAIL_COMPONENTS.map((c) => (c.kind === "rental" ? { ...c, credits: 120 } : c)));
    const newVersion = await offeringPriceVersion(quote.offeringId, raised);
    expect(newVersion).not.toBe(quote.priceVersion);
    expect(await verifyOfferingQuote(h.env, quote.quoteId, { ...expect_, priceVersion: newVersion })).toEqual({ ok: false, error_code: "quote_price_changed" });
  });
  it("refuses any binding mismatch and hides other tenants' quotes", async () => {
    const { h, quote, expect_ } = await setup();
    const mismatch = { ok: false, error_code: "quote_binding_mismatch" };
    expect(await verifyOfferingQuote(h.env, quote.quoteId, { ...expect_, region: "eu" })).toEqual(mismatch);
    expect(await verifyOfferingQuote(h.env, quote.quoteId, { ...expect_, offeringId: "offering-other" })).toEqual(mismatch);
    expect(await verifyOfferingQuote(h.env, quote.quoteId, { ...expect_, configuration: { display: "B", domain: "mail.test" } })).toEqual(mismatch);
    expect(await verifyOfferingQuote(h.env, quote.quoteId, { ...expect_, tenantId: "tenant-b" })).toEqual({ ok: false, error_code: "quote_not_found" });
    expect(await verifyOfferingQuote(h.env, "msq_" + "0".repeat(32), expect_)).toEqual({ ok: false, error_code: "quote_not_found" });
  });
  it("refuses a consumed quote", async () => {
    const { h, quote, expect_ } = await setup();
    h.f.db.db.prepare("UPDATE managed_service_operation_quotes SET status='consumed' WHERE quote_id=?").run(quote.quoteId);
    expect(await verifyOfferingQuote(h.env, quote.quoteId, expect_)).toEqual({ ok: false, error_code: "quote_already_used" });
  });
});

describe("MS-37 AgentMail quote creation: flag off and on store the same Billing-visible fields", () => {
  async function agentMailQuote(flag: boolean) {
    const f = fixture();
    if (flag) enableManagedOfferingsFixture(f.db, f.env);
    const env = f.env as unknown as AgentsEnv & Record<string, unknown>;
    env.AGENTMAIL_REGION = "us"; env.AGENTMAIL_DEFAULT_DOMAIN = "mail.test";
    f.db.db.prepare(`UPDATE managed_service_capability_versions SET status='verified',verified_by='op',verified_at=?,valid_until='2099-01-01T00:00:00.000Z',regions_json='["us"]'
      WHERE provider='agentmail' AND service_id='agentmail' AND version=1`).run(NOW.toISOString());
    for (const [operation, credits] of [["provision", 300], ["renew", 250]] as const) f.db.db.prepare(`INSERT INTO managed_service_plan_entitlements(
      plan_tier,provider,service_id,capability_version,operation_name,region,price_version,max_credits_per_operation,credits_per_operation,max_operations_per_period,
      status,verified_by,verified_at,valid_until,created_at,updated_at) VALUES('free','agentmail','agentmail',1,?,'us','agentmail-rental-v2',400,?,20,'active','op',?,'2099-01-01T00:00:00.000Z',datetime('now'),datetime('now'))`)
      .run(operation, credits, NOW.toISOString());
    const identity = await ensureIdentity(env, scope);
    const quote = await createManagedAgentMailQuote(env, scope, identity, {}, NOW);
    const row = f.db.db.prepare("SELECT * FROM managed_service_operation_quotes WHERE quote_id=?").get(quote.quoteId) as Record<string, unknown>;
    return { quote, row };
  }
  const LEGACY = ["tenant_id", "space_id", "project_id", "requester_user_id", "plan_tier", "provider", "service_id", "operation_name", "model_id", "region",
    "capability_version", "price_version", "credits", "max_output_tokens", "status", "operation_id", "expires_at", "consumed_at", "created_at", "request_sha256",
    "renewal_credits", "renewal_price_version", "renewal_capability_version", "renewal_max_credits_per_operation"];
  it("matches field for field and only adds offering columns when on", async () => {
    let off: Awaited<ReturnType<typeof agentMailQuote>>, on: Awaited<ReturnType<typeof agentMailQuote>>;
    try { off = await agentMailQuote(false); } catch (e) { throw new Error(`flag off: ${(e as Error).message}`); }
    try { on = await agentMailQuote(true); } catch (e) { throw new Error(`flag on: ${(e as Error).message}`); }
    for (const key of LEGACY) expect(on.row[key], key).toEqual(off.row[key]);
    expect(off.row).not.toHaveProperty("offering_id");
    expect(on.row).toMatchObject({ offering_id: "offering-agentmail-agentmail", min_monthly_credits: 0 });
    expect(off.quote.expiresAt).toBe(on.quote.expiresAt);
    expect(on.quote.credits).toBe(300);
    expect(on.quote).toMatchObject({ renewalCredits: 250, maxCreditsPerPeriod: off.quote.maxCreditsPerPeriod, minMonthlyCredits: 0, components: [] });
    expect(off.quote).not.toHaveProperty("offeringId");
  });
});
