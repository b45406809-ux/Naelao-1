/**
 * Developer Partner Program, Commission Attribution & Tier-Based Settlement Engine
 * 
 * Supports 3 Marketplace Monetization Scenarios:
 * 1. DEVELOPER_REFERRAL: Direct client link / QR code onboarding -> Developer earns 40% recurring (20% build + 20% distribution), Platform keeps 60%.
 * 2. MARKETPLACE_ORGANIC: Found via platform directory -> Developer earns 20% recurring build royalty, Platform keeps 80%.
 * 3. FIXED_ONE_OFF: 100% of upfront template price to developer, 0% on ongoing monthly platform compute.
 * 
 * Tier-Based Commission Duration Constraints:
 * - Entry Tier (< $50/mo, e.g. $20/mo): 6 Months only (max_commission_cycles = 6), drops to 0% after.
 * - Growth Tier ($50 - < $150/mo, e.g. $50/mo): 12 Months (max_commission_cycles = 12), drops to 0% after.
 * - Pro Tier ($150+/mo): Lifetime Recurring (max_commission_cycles = null).
 */

export type AttributionChannel = "DEVELOPER_REFERRAL" | "MARKETPLACE_ORGANIC" | "FIXED_ONE_OFF";

export type MonetizationType = "subscription" | "fixed_one_off";

export type MonetizationModel = "FREEMIUM_TIERED_SAAS" | "FIXED_ONE_OFF_UNLOCKED";

export interface PlanTierAccessRule {
  allowedProjectKinds: string[];
  allowedPlugins: string[];
  maxExecutionTier: number;
  monthlyQueryAllowance: number;
}

export interface TierAccessRules {
  entryPlan: PlanTierAccessRule;   // $20 / mo (plans <= $25)
  growthPlan: PlanTierAccessRule;  // $50 / mo (plans $26 - $149)
  proPlan: PlanTierAccessRule;     // $150+ / mo (plans >= $150)
}

export interface TemplateFeatureGating {
  monetizationModel: MonetizationModel;
  fixedPriceCents?: number;
  tierAccessRules?: TierAccessRules;
}

export interface PartnerAccount {
  id: string;
  userId: string;
  displayName: string;
  payoutEmail: string;
  payoutDestinationJson?: string | null;
  commissionRatePct: number;
  totalEarnedCents: number;
  balanceCents: number;
  createdAt: string;
}

export interface PartnerTemplate {
  id: string;
  partnerId: string;
  name: string;
  category: string;
  description: string;
  blueprintR2Key: string;
  priceCentsMonthly: number;
  priceCentsOneOff: number;
  fixedPriceCents?: number;
  monetizationType: MonetizationType;
  monetizationModel: MonetizationModel;
  tierAccessRules?: TierAccessRules | null;
  isPublic: boolean;
  createdAt: string;
}

export interface TemplateSubscription {
  id: string;
  spaceId: string;
  templateId: string;
  developerUserId: string;
  attributionChannel: AttributionChannel;
  monthlySubCents: number;
  developerSplitPct: number;
  cyclesPaidEntryTier: number;
  cyclesPaidGrowthTier: number;
  cyclesPaidProTier: number;
  billingCycleCount: number;
  maxCommissionCycles: number | null;
  lastBilledPlanPriceCents: number;
  status: "active" | "paused" | "cancelled";
  updatedAt: string;
  createdAt: string;
}

export interface DeveloperEarningsLedgerEntry {
  id: string;
  developerUserId: string;
  spaceId: string;
  eventType: "monthly_subscription_cut" | "one_off_license_sale";
  grossCents: number;
  developerCutCents: number;
  platformCutCents: number;
  period: string; // YYYY-MM
  createdAt: string;
}

export interface PartnerClientRosterItem {
  spaceId: string;
  templateId: string;
  templateName?: string;
  clientBusinessName?: string;
  monthlySubCents: number;
  developerCutCents: number;
  attributionChannel: AttributionChannel;
  billingCycleCount: number;
  cyclesPaidEntryTier: number;
  cyclesPaidGrowthTier: number;
  cyclesPaidProTier: number;
  maxCommissionCycles: number | null;
  status: "active" | "paused" | "cancelled";
  tierName: "Entry ($20/mo)" | "Growth ($50/mo)" | "Pro ($150+/mo)" | "Custom";
  durationStatus: "lifetime" | "in_progress" | "expired";
  remainingCycles: number | null;
  upgradePitchRecommended: boolean;
}

export interface PartnerEarningsSummary {
  partnerId: string;
  userId: string;
  displayName: string;
  payoutEmail: string;
  totalEarnedCents: number;
  balanceCents: number;
  activeClientsCount: number;
  monthlyRecurringCommissionCents: number;
  recentLedgerEntries: DeveloperEarningsLedgerEntry[];
  clientRoster: PartnerClientRosterItem[];
}

/**
 * Validates feature access against template tier access rules.
 * Model B (FIXED_ONE_OFF_UNLOCKED) always returns 100% allowed.
 * Model A (FREEMIUM_TIERED_SAAS) gates projects by monthly plan price.
 */
export function verifyFeatureAccess(
  spaceCurrentPlanPriceUsd: number,
  requestedProjectKind: string,
  gatingRules?: TemplateFeatureGating
): { allowed: boolean; requiredPlan?: string; reason?: string } {
  if (!gatingRules || gatingRules.monetizationModel === "FIXED_ONE_OFF_UNLOCKED") {
    return { allowed: true };
  }
  const rules = gatingRules.tierAccessRules;
  if (!rules) return { allowed: true };

  // Evaluate Plan Tier Clearance
  if (spaceCurrentPlanPriceUsd < 50) {
    // Entry Plan (< $50/mo, e.g. $20/mo)
    if (!rules.entryPlan.allowedProjectKinds.includes(requestedProjectKind) && !rules.entryPlan.allowedProjectKinds.includes("*")) {
      return {
        allowed: false,
        requiredPlan: "$50 Growth Plan or $150 Pro Plan",
        reason: `The '${requestedProjectKind}' workstation is locked on your current plan.`,
      };
    }
  } else if (spaceCurrentPlanPriceUsd < 150) {
    // Growth Plan ($50 to < $150/mo)
    if (!rules.growthPlan.allowedProjectKinds.includes(requestedProjectKind) && !rules.growthPlan.allowedProjectKinds.includes("*")) {
      return {
        allowed: false,
        requiredPlan: "$150 Pro Plan",
        reason: `The '${requestedProjectKind}' workstation is exclusive to the $150 Pro Plan.`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Resolves the maximum commission cycles based on the monthly subscription price tier:
 * - < $50/mo (e.g. $20/mo Entry): 6 Months
 * - $50 to < $150/mo (e.g. $50/mo Growth): 12 Months
 * - $150+/mo (Pro): Lifetime (null)
 */
export function getMaxCommissionCycles(planPriceCents: number): number | null {
  const planUsd = planPriceCents / 100;
  if (planUsd < 50) {
    return 6;
  }
  if (planUsd < 150) {
    return 12;
  }
  return null; // Unlimited / Lifetime
}

/**
 * Checks whether a given billing cycle is eligible for commission payout.
 */
export function isCommissionCycleEligible(cycleCount: number, maxCycles: number | null | undefined): boolean {
  if (maxCycles === null || maxCycles === undefined) {
    return true; // Lifetime
  }
  return cycleCount <= maxCycles;
}

/**
 * Computes the exact revenue split, developer cut, platform cut, and remaining cycle status.
 */
export function computeDeveloperCommissionSplit(params: {
  attributionChannel: AttributionChannel;
  grossCents: number;
  cycleCount: number;
  maxCommissionCycles?: number | null;
}): {
  developerRate: number;
  developerCutCents: number;
  platformCutCents: number;
  isEligible: boolean;
  remainingCycles: number | null;
} {
  const { attributionChannel, grossCents, cycleCount, maxCommissionCycles } = params;

  if (attributionChannel === "FIXED_ONE_OFF") {
    return {
      developerRate: 0.0,
      developerCutCents: 0,
      platformCutCents: grossCents,
      isEligible: false,
      remainingCycles: 0,
    };
  }

  const effectiveMax = maxCommissionCycles !== undefined ? maxCommissionCycles : getMaxCommissionCycles(grossCents);
  const isEligible = isCommissionCycleEligible(cycleCount, effectiveMax);

  let developerRate = 0.0;
  if (isEligible) {
    if (attributionChannel === "DEVELOPER_REFERRAL") {
      developerRate = 0.40; // 40% (20% build + 20% sales distribution)
    } else if (attributionChannel === "MARKETPLACE_ORGANIC") {
      developerRate = 0.20; // 20% (build royalty)
    }
  }

  const developerCutCents = Math.round(grossCents * developerRate);
  const platformCutCents = grossCents - developerCutCents;
  const remainingCycles = effectiveMax !== null ? Math.max(0, effectiveMax - cycleCount) : null;

  return {
    developerRate,
    developerCutCents,
    platformCutCents,
    isEligible,
    remainingCycles,
  };
}

/**
 * Minimal D1 database interface for settlement execution.
 */
export interface MinimalD1 {
  prepare(query: string): {
    bind(...params: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

/**
 * Automated settlement function invoked when a client subscription payment is recorded.
 * Evaluates per-tier cumulative quota counters to prevent plan-hopping gaming.
 */
export async function settleTemplateSubscriptionPayment(
  db: MinimalD1,
  spaceId: string,
  grossCents: number,
  forcedPeriod?: string
): Promise<{
  settled: boolean;
  developerCutCents: number;
  platformCutCents: number;
  cycleCount: number;
  period: string;
  isEligible: boolean;
  developerUserId?: string;
  tierCounts?: {
    entry: number;
    growth: number;
    pro: number;
  };
} | null> {
  const sub = await db
    .prepare("SELECT * FROM template_subscriptions WHERE space_id = ? AND status = 'active'")
    .bind(spaceId)
    .first<{
      id: string;
      space_id: string;
      template_id: string;
      developer_user_id: string;
      attribution_channel: AttributionChannel;
      monthly_sub_cents: number;
      billing_cycle_count?: number;
      cycles_paid_entry_tier?: number;
      cycles_paid_growth_tier?: number;
      cycles_paid_pro_tier?: number;
      max_commission_cycles?: number | null;
      developer_split_pct: number;
    }>();

  if (!sub) {
    return null; // Not a template-driven subscription
  }

  const planPriceUsd = grossCents / 100;
  let isCommissionEligible = false;
  let newEntryCount = sub.cycles_paid_entry_tier || 0;
  let newGrowthCount = sub.cycles_paid_growth_tier || 0;
  let newProCount = sub.cycles_paid_pro_tier || 0;
  const currentTotalCycle = (sub.billing_cycle_count || 0) + 1;

  if (planPriceUsd <= 25) {
    // Entry Tier ($20/mo): Maximum 6 Paid Cycles
    newEntryCount += 1;
    await db
      .prepare(
        `UPDATE template_subscriptions 
         SET cycles_paid_entry_tier = ?, billing_cycle_count = ?, last_billed_plan_price_cents = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(newEntryCount, currentTotalCycle, grossCents, sub.id)
      .run();
    isCommissionEligible = newEntryCount <= 6;
  } else if (planPriceUsd < 150) {
    // Growth Tier ($50/mo): Maximum 12 Paid Cycles
    newGrowthCount += 1;
    await db
      .prepare(
        `UPDATE template_subscriptions 
         SET cycles_paid_growth_tier = ?, billing_cycle_count = ?, last_billed_plan_price_cents = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(newGrowthCount, currentTotalCycle, grossCents, sub.id)
      .run();
    isCommissionEligible = newGrowthCount <= 12;
  } else {
    // Pro Tier ($150+/mo): LIFETIME UNLIMITED
    newProCount += 1;
    await db
      .prepare(
        `UPDATE template_subscriptions 
         SET cycles_paid_pro_tier = ?, billing_cycle_count = ?, last_billed_plan_price_cents = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(newProCount, currentTotalCycle, grossCents, sub.id)
      .run();
    isCommissionEligible = true; // Always eligible for lifetime!
  }

  let developerRate = 0.0;
  if (isCommissionEligible) {
    if (sub.attribution_channel === "DEVELOPER_REFERRAL") {
      developerRate = 0.40; // 40%
    } else if (sub.attribution_channel === "MARKETPLACE_ORGANIC") {
      developerRate = 0.20; // 20%
    }
  }

  const developerCutCents = Math.round(grossCents * developerRate);
  const platformCutCents = grossCents - developerCutCents;

  const period = forcedPeriod || new Date().toISOString().slice(0, 7);
  const ledgerId = `earn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // Record in Developer Earnings Ledger
  await db
    .prepare(
      `INSERT INTO developer_earnings_ledger (
        id, developer_user_id, space_id, event_type, gross_cents, developer_cut_cents, platform_cut_cents, period
      ) VALUES (?, ?, ?, 'monthly_subscription_cut', ?, ?, ?, ?)`
    )
    .bind(
      ledgerId,
      sub.developer_user_id,
      spaceId,
      grossCents,
      developerCutCents,
      platformCutCents,
      period
    )
    .run();

  // If developer received a cut, credit partner account balance
  if (developerCutCents > 0) {
    await db
      .prepare(
        `UPDATE partner_accounts 
         SET total_earned_cents = total_earned_cents + ?, balance_cents = balance_cents + ?
         WHERE user_id = ?`
      )
      .bind(developerCutCents, developerCutCents, sub.developer_user_id)
      .run();
  }

  return {
    settled: true,
    developerCutCents,
    platformCutCents,
    cycleCount: currentTotalCycle,
    period,
    isEligible: isCommissionEligible,
    developerUserId: sub.developer_user_id,
    tierCounts: {
      entry: newEntryCount,
      growth: newGrowthCount,
      pro: newProCount,
    },
  };
}

/**
 * Settles a fixed one-off template buy-out / license sale:
 * Developer receives 100% of upfront price ($0 platform cut on upfront template license).
 */
export async function settleOneOffTemplatePurchase(
  db: MinimalD1,
  spaceId: string,
  templateId: string,
  developerUserId: string,
  grossCents: number,
  forcedPeriod?: string
): Promise<{
  settled: boolean;
  developerCutCents: number;
  platformCutCents: number;
  period: string;
}> {
  const developerCutCents = grossCents; // 100% to developer
  const platformCutCents = 0;
  const period = forcedPeriod || new Date().toISOString().slice(0, 7);
  const ledgerId = `earn_fixed_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // Record in Developer Earnings Ledger
  await db
    .prepare(
      `INSERT INTO developer_earnings_ledger (
        id, developer_user_id, space_id, event_type, gross_cents, developer_cut_cents, platform_cut_cents, period
      ) VALUES (?, ?, ?, 'one_off_license_sale', ?, ?, ?, ?)`
    )
    .bind(
      ledgerId,
      developerUserId,
      spaceId,
      grossCents,
      developerCutCents,
      platformCutCents,
      period
    )
    .run();

  // Credit partner account
  await db
    .prepare(
      `UPDATE partner_accounts 
       SET total_earned_cents = total_earned_cents + ?, balance_cents = balance_cents + ?
       WHERE user_id = ?`
    )
    .bind(developerCutCents, developerCutCents, developerUserId)
    .run();

  return {
    settled: true,
    developerCutCents,
    platformCutCents,
    period,
  };
}

/**
 * Fetches the full partner dashboard summary with client roster and duration breakdown.
 */
export async function getPartnerEarningsSummary(
  db: MinimalD1,
  userId: string
): Promise<PartnerEarningsSummary | null> {
  const partner = await db
    .prepare("SELECT * FROM partner_accounts WHERE user_id = ?")
    .bind(userId)
    .first<{
      id: string;
      user_id: string;
      display_name: string;
      payout_email: string;
      commission_rate_pct: number;
      total_earned_cents: number;
      balance_cents: number;
      created_at: string;
    }>();

  if (!partner) {
    return null;
  }

  // Get recent ledger entries
  const ledgerRes = await db
    .prepare(
      "SELECT * FROM developer_earnings_ledger WHERE developer_user_id = ? ORDER BY created_at DESC LIMIT 20"
    )
    .bind(userId)
    .all<{
      id: string;
      developer_user_id: string;
      space_id: string;
      event_type: "monthly_subscription_cut" | "one_off_license_sale";
      gross_cents: number;
      developer_cut_cents: number;
      platform_cut_cents: number;
      period: string;
      created_at: string;
    }>();

  const recentLedgerEntries: DeveloperEarningsLedgerEntry[] = (ledgerRes.results || []).map((row) => ({
    id: row.id,
    developerUserId: row.developer_user_id,
    spaceId: row.space_id,
    eventType: row.event_type,
    grossCents: row.gross_cents,
    developerCutCents: row.developer_cut_cents,
    platformCutCents: row.platform_cut_cents,
    period: row.period,
    createdAt: row.created_at,
  }));

  // Get active client subscriptions
  const subsRes = await db
    .prepare("SELECT * FROM template_subscriptions WHERE developer_user_id = ?")
    .bind(userId)
    .all<{
      id: string;
      space_id: string;
      template_id: string;
      developer_user_id: string;
      attribution_channel: AttributionChannel;
      monthly_sub_cents: number;
      billing_cycle_count?: number;
      cycles_paid_entry_tier?: number;
      cycles_paid_growth_tier?: number;
      cycles_paid_pro_tier?: number;
      max_commission_cycles?: number | null;
      developer_split_pct: number;
      status: "active" | "paused" | "cancelled";
      created_at: string;
    }>();

  let monthlyRecurringCommissionCents = 0;
  const clientRoster: PartnerClientRosterItem[] = (subsRes.results || []).map((sub) => {
    const planUsd = sub.monthly_sub_cents / 100;
    const rawCycleCount = sub.billing_cycle_count || 0;
    const entryCount = (sub.cycles_paid_entry_tier !== undefined && sub.cycles_paid_entry_tier > 0)
      ? sub.cycles_paid_entry_tier
      : (planUsd < 50 ? rawCycleCount : 0);
    const growthCount = (sub.cycles_paid_growth_tier !== undefined && sub.cycles_paid_growth_tier > 0)
      ? sub.cycles_paid_growth_tier
      : (planUsd >= 50 && planUsd < 150 ? rawCycleCount : 0);
    const proCount = (sub.cycles_paid_pro_tier !== undefined && sub.cycles_paid_pro_tier > 0)
      ? sub.cycles_paid_pro_tier
      : (planUsd >= 150 ? rawCycleCount : 0);

    let tierName: PartnerClientRosterItem["tierName"] = "Custom";
    let isEligible = false;
    let durationStatus: PartnerClientRosterItem["durationStatus"] = "lifetime";
    let remainingCycles: number | null = null;
    let upgradePitchRecommended = false;

    if (planUsd < 50) {
      tierName = "Entry ($20/mo)";
      isEligible = entryCount <= 6;
      remainingCycles = Math.max(0, 6 - entryCount);
      durationStatus = entryCount < 6 ? "in_progress" : "expired";
      upgradePitchRecommended = sub.status === "active" && remainingCycles <= 2;
    } else if (planUsd < 150) {
      tierName = "Growth ($50/mo)";
      isEligible = growthCount <= 12;
      remainingCycles = Math.max(0, 12 - growthCount);
      durationStatus = growthCount < 12 ? "in_progress" : "expired";
      upgradePitchRecommended = sub.status === "active" && remainingCycles <= 2;
    } else {
      tierName = "Pro ($150+/mo)";
      isEligible = true;
      remainingCycles = null;
      durationStatus = "lifetime";
      upgradePitchRecommended = false;
    }

    let developerRate = 0.0;
    if (isEligible) {
      if (sub.attribution_channel === "DEVELOPER_REFERRAL") {
        developerRate = 0.40;
      } else if (sub.attribution_channel === "MARKETPLACE_ORGANIC") {
        developerRate = 0.20;
      }
    }

    const developerCutCents = Math.round(sub.monthly_sub_cents * developerRate);

    if (sub.status === "active" && isEligible) {
      monthlyRecurringCommissionCents += developerCutCents;
    }

    return {
      spaceId: sub.space_id,
      templateId: sub.template_id,
      monthlySubCents: sub.monthly_sub_cents,
      developerCutCents,
      attributionChannel: sub.attribution_channel,
      billingCycleCount: sub.billing_cycle_count || 0,
      cyclesPaidEntryTier: entryCount,
      cyclesPaidGrowthTier: growthCount,
      cyclesPaidProTier: proCount,
      maxCommissionCycles: sub.max_commission_cycles !== undefined ? sub.max_commission_cycles : (planUsd <= 25 ? 6 : planUsd < 150 ? 12 : null),
      status: sub.status,
      tierName,
      durationStatus,
      remainingCycles,
      upgradePitchRecommended,
    };
  });

  return {
    partnerId: partner.id,
    userId: partner.user_id,
    displayName: partner.display_name,
    payoutEmail: partner.payout_email,
    totalEarnedCents: partner.total_earned_cents,
    balanceCents: partner.balance_cents,
    activeClientsCount: clientRoster.filter((c) => c.status === "active").length,
    monthlyRecurringCommissionCents,
    recentLedgerEntries,
    clientRoster,
  };
}
