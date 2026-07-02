import { describe, it, expect } from "vitest";
import {
  computeResellerAttribution,
  isLedgerEvent,
  billingPeriod,
  type ResellerConfig,
} from "../../packages/billing-core/src/reseller.js";
import type { NormalizedBillingEvent } from "../../packages/billing-core/src/providers/types.js";

function evt(
  type: NormalizedBillingEvent["type"],
  amountCents: number,
  currency = "USD"
): Pick<NormalizedBillingEvent, "type" | "amountCents" | "currency"> {
  return { type, amountCents, currency };
}

describe("reseller billing attribution (G-AS34/G-AS35)", () => {
  it("platform relationship attributes nothing", () => {
    const cfg: ResellerConfig = { billingRelationship: "platform" };
    expect(computeResellerAttribution(evt("payment.success", 5000), cfg)).toBeNull();
  });

  it("non-revenue events are ignored", () => {
    const cfg: ResellerConfig = { billingRelationship: "reseller", wholesaleCents: 1000 };
    for (const t of ["payment.failed", "subscription.paused", "subscription.cancelled"] as const) {
      expect(computeResellerAttribution(evt(t, 5000), cfg)).toBeNull();
    }
  });

  it("reseller mode keeps the spread between retail and wholesale", () => {
    const cfg: ResellerConfig = { billingRelationship: "reseller", wholesaleCents: 2000 };
    const a = computeResellerAttribution(evt("payment.success", 5000), cfg)!;
    expect(a.relationship).toBe("reseller");
    expect(a.retailCents).toBe(5000);
    expect(a.wholesaleCents).toBe(2000);
    expect(a.marginCents).toBe(3000); // reseller keeps 5000 - 2000
  });

  it("reseller mode with unset wholesale passes through at retail (zero margin)", () => {
    const cfg: ResellerConfig = { billingRelationship: "reseller", wholesaleCents: null };
    const a = computeResellerAttribution(evt("subscription.created", 4900), cfg)!;
    expect(a.wholesaleCents).toBe(4900);
    expect(a.marginCents).toBe(0);
  });

  it("referral mode pays a percentage of retail and Naelao bears no wholesale", () => {
    const cfg: ResellerConfig = { billingRelationship: "referral", referralSharePct: 30 };
    const a = computeResellerAttribution(evt("payment.success", 10000), cfg)!;
    expect(a.relationship).toBe("referral");
    expect(a.wholesaleCents).toBe(0);
    expect(a.marginCents).toBe(3000); // 30% of 10000
  });

  it("referral share is clamped to [0,100]", () => {
    const over = computeResellerAttribution(evt("payment.success", 10000), {
      billingRelationship: "referral",
      referralSharePct: 250,
    })!;
    expect(over.marginCents).toBe(10000); // clamped to 100%

    const under = computeResellerAttribution(evt("payment.success", 10000), {
      billingRelationship: "referral",
      referralSharePct: -50,
    })!;
    expect(under.marginCents).toBe(0); // clamped to 0%
  });

  it("refunds reverse the attribution (negative cents)", () => {
    const cfg: ResellerConfig = { billingRelationship: "reseller", wholesaleCents: 2000 };
    const a = computeResellerAttribution(evt("refund.issued", 5000), cfg)!;
    expect(a.retailCents).toBe(-5000);
    expect(a.wholesaleCents).toBe(-2000);
    expect(a.marginCents).toBe(-3000);
  });

  it("preserves the event currency", () => {
    const a = computeResellerAttribution(evt("payment.success", 5000, "EUR"), {
      billingRelationship: "referral",
      referralSharePct: 10,
    })!;
    expect(a.currency).toBe("EUR");
  });

  it("isLedgerEvent only fires for revenue + refund events", () => {
    expect(isLedgerEvent("payment.success")).toBe(true);
    expect(isLedgerEvent("subscription.resumed")).toBe(true);
    expect(isLedgerEvent("refund.issued")).toBe(true);
    expect(isLedgerEvent("payment.failed")).toBe(false);
    expect(isLedgerEvent("subscription.cancelled")).toBe(false);
  });

  it("billingPeriod returns a UTC YYYY-MM bucket", () => {
    expect(billingPeriod(Date.UTC(2026, 0, 15))).toBe("2026-01");
    expect(billingPeriod(Date.UTC(2026, 11, 1))).toBe("2026-12");
  });
});
