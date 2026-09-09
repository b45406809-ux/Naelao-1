import { D1Database } from "@cloudflare/workers-types";

export interface SettlementResult {
  ok: boolean;
  grossCents: number;
  developerCutCents: number;
  platformCutCents: number;
  developerUserId: string;
}

/**
 * Evaluates cumulative subscription billing cycles and executes 
 * automated multi-party revenue splits upon successful invoice webhooks.
 */
export async function settleTemplateSubscriptionPayment(
  db: D1Database,
  spaceId: string,
  grossCents: number
): Promise<SettlementResult | null> {
  // 1. Fetch active subscription record for this business space
  const sub = await db.prepare(
    "SELECT * FROM template_subscriptions WHERE space_id = ? AND status = 'active'"
  ).bind(spaceId).first<any>();

  if (!sub) {
    return null; // Not a template-driven subscription
  }

  const planPriceUsd = grossCents / 100;
  let isCommissionEligible = false;

  // 2. Evaluate & Increment Per-Tier Cumulative Quotas
  if (planPriceUsd <= 25) {
    const newEntryCount = (sub.cycles_paid_entry_tier || 0) + 1;
    await db.prepare(
      "UPDATE template_subscriptions SET cycles_paid_entry_tier = ?, last_billed_plan_price_cents = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(newEntryCount, grossCents, sub.id).run();

    // Eligible ONLY if cycle 1 through 6
    isCommissionEligible = newEntryCount <= 6;
  } else if (planPriceUsd < 150) {
    const newGrowthCount = (sub.cycles_paid_growth_tier || 0) + 1;
    await db.prepare(
      "UPDATE template_subscriptions SET cycles_paid_growth_tier = ?, last_billed_plan_price_cents = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(newGrowthCount, grossCents, sub.id).run();

    // Eligible ONLY if cycle 1 through 12
    isCommissionEligible = newGrowthCount <= 12;
  } else {
    const newProCount = (sub.cycles_paid_pro_tier || 0) + 1;
    await db.prepare(
      "UPDATE template_subscriptions SET cycles_paid_pro_tier = ?, last_billed_plan_price_cents = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(newProCount, grossCents, sub.id).run();

    // Pro Tier ($150+/mo) is Lifetime Unlimited
    isCommissionEligible = true;
  }

  // 3. Compute Multi-Party Revenue Split
  let developerRate = 0.0;
  if (isCommissionEligible) {
    if (sub.attribution_channel === "DEVELOPER_REFERRAL") {
      developerRate = 0.40; // 40% (Developer brought the client)
    } else if (sub.attribution_channel === "MARKETPLACE_ORGANIC") {
      developerRate = 0.20; // 20% (Found in marketplace)
    }
  }

  const developerCutCents = Math.round(grossCents * developerRate);
  const platformCutCents = grossCents - developerCutCents;
  const period = new Date().toISOString().slice(0, 7);

  // 4. Record Settlement in Developer Earnings Ledger
  const ledgerId = `earn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await db.prepare(
    `INSERT INTO developer_earnings_ledger (
       id, developer_user_id, space_id, event_type, gross_cents, developer_cut_cents, platform_cut_cents, period
     ) VALUES (?, ?, ?, 'subscription_cut', ?, ?, ?, ?)`
  ).bind(
    ledgerId,
    sub.developer_user_id,
    spaceId,
    grossCents,
    developerCutCents,
    platformCutCents,
    period
  ).run();

  return {
    ok: true,
    grossCents,
    developerCutCents,
    platformCutCents,
    developerUserId: sub.developer_user_id
  };
}
