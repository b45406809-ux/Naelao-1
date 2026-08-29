/**
 * Reseller billing attribution (spec G-AS34 Agency Partner Program / G-AS35 White-Label
 * Reseller). Pure functions — no I/O — so they are trivially unit-testable and reusable
 * from the billing worker.
 *
 * When a child tenant (a customer who created their own business under a reseller's
 * product) generates a billing event, we attribute it to the parent reseller according to
 * the reseller's `billing_relationship`:
 *
 *   - "reseller":  Naelao bills the reseller WHOLESALE; the reseller keeps the margin
 *                  (retail − wholesale) and owns the customer invoice. Spec G-AS35.
 *   - "referral":  Naelao bills the customer directly and pays the reseller a rev-share
 *                  (referral_share_pct % of retail). The reseller's "margin" is that share.
 *   - "platform":  No resale relationship — the child tenant is billed exactly like any
 *                  builder and nothing is attributed to the parent.
 */

import type { NormalizedBillingEvent } from "./providers/types";

export type BillingRelationship = "reseller" | "referral" | "platform";

export interface ResellerConfig {
  billingRelationship: BillingRelationship;
  /**
   * reseller mode: fixed wholesale cost (cents) Naelao charges the reseller for the
   * child subscription period. When undefined/null, wholesale passes through at retail
   * (zero margin) — a safe default until the reseller sets their wholesale rate.
   */
  wholesaleCents?: number | null;
  /** referral mode: percent (0-100) of retail revenue Naelao pays the reseller. */
  referralSharePct?: number;
}

export interface ResellerAttribution {
  relationship: BillingRelationship;
  /** What the customer paid (the event amount). */
  retailCents: number;
  /** What Naelao bills the reseller for this event. */
  wholesaleCents: number;
  /** The reseller's economic benefit: margin (reseller) or rev-share earned (referral). */
  marginCents: number;
  currency: string;
}

/** Event types that move money and should hit the reseller ledger. */
const REVENUE_EVENTS = new Set<NormalizedBillingEvent["type"]>([
  "payment.success",
  "subscription.created",
  "subscription.updated",
  "subscription.resumed",
]);

/** Refunds reverse revenue (negative attribution). */
const REVERSAL_EVENTS = new Set<NormalizedBillingEvent["type"]>(["refund.issued"]);

/** Whether a billing event should produce a reseller-ledger entry at all. */
export function isLedgerEvent(eventType: NormalizedBillingEvent["type"]): boolean {
  return REVENUE_EVENTS.has(eventType) || REVERSAL_EVENTS.has(eventType);
}

function clampPct(pct: number | undefined): number {
  if (pct === undefined || Number.isNaN(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Compute how a child-tenant billing event is attributed to its parent reseller.
 * Returns null when there is nothing to attribute (platform relationship or a
 * non-revenue event like payment.failed / subscription.paused / cancelled).
 */
export function computeResellerAttribution(
  event: Pick<NormalizedBillingEvent, "type" | "amountCents" | "currency">,
  config: ResellerConfig
): ResellerAttribution | null {
  if (config.billingRelationship === "platform") return null;
  if (!isLedgerEvent(event.type)) return null;

  const sign = REVERSAL_EVENTS.has(event.type) ? -1 : 1;
  const retailCents = sign * Math.abs(Math.round(event.amountCents));
  const currency = event.currency || "USD";

  if (config.billingRelationship === "reseller") {
    // Wholesale is a fixed per-period cost; pass-through at retail when unset.
    const baseWholesale =
      config.wholesaleCents === undefined || config.wholesaleCents === null
        ? Math.abs(retailCents)
        : Math.max(0, Math.round(config.wholesaleCents));
    const wholesaleCents = sign * baseWholesale;
    const marginCents = retailCents - wholesaleCents; // reseller keeps the spread
    return { relationship: "reseller", retailCents, wholesaleCents, marginCents, currency };
  }

  // referral: Naelao collects retail, pays the reseller a share. From Naelao's books the
  // reseller's "wholesale" cost is zero; the reseller earns referralSharePct of retail.
  const sharePct = clampPct(config.referralSharePct);
  const marginCents = Math.round((retailCents * sharePct) / 100);
  return { relationship: "referral", retailCents, wholesaleCents: 0, marginCents, currency };
}

/** YYYY-MM bucket for ledger rollup, from a timestamp (defaults to now). */
export function billingPeriod(at: number = Date.now()): string {
  const d = new Date(at);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}`;
}
