export type AttributionChannel = "DEVELOPER_REFERRAL" | "MARKETPLACE_ORGANIC";
export type SettlementTier = "entry" | "growth" | "pro";

export interface SettlementResult {
  ledgerId: string;
  subscriptionId: string;
  tier: SettlementTier;
  cycle: number;
  grossCents: number;
  developerCents: number;
  platformCents: number;
  commissionEligible: boolean;
}

export function tierForPlanPrice(priceCents: number): SettlementTier {
  if (!Number.isInteger(priceCents) || priceCents <= 0)
    throw new Error("grossCents must be a positive integer");
  if (priceCents <= 2_500) return "entry";
  if (priceCents <= 10_000) return "growth";
  if (priceCents >= 15_000) return "pro";
  throw new Error("Plan price does not belong to a commission tier");
}

export function developerCommissionBps(channel: AttributionChannel): number {
  void channel;
  return 2_500;
}

export function calculateDeveloperCommission(
  grossCents: number,
  channel: AttributionChannel,
  tier: SettlementTier,
  cycle: number,
  pioneer = false
): number {
  if (!Number.isInteger(cycle) || cycle < 1) throw new Error("cycle must be a positive integer");
  // Later source correction supersedes perpetual/tier-reset proposals: pioneer FDEs get
  // 40% for months 1–6; the standard cohort gets 25%; everyone decays to 20%, then 5%.
  // Attribution channel remains recorded for provenance and referral validation.
  void channel;
  void tier;
  const bps = cycle <= 6 ? (pioneer ? 4_000 : 2_500) : cycle <= 12 ? 2_000 : 500;
  return Math.floor((grossCents * bps) / 10_000);
}

/** A fixed license is paid to its developer once; later compute revenue is never shared. */
export function calculateFixedLicenseCommission(grossCents: number): number {
  if (
    !Number.isInteger(grossCents) ||
    grossCents < 4_900 ||
    grossCents > 49_900
  )
    throw new Error("Invalid fixed-license gross");
  return grossCents;
}

/**
 * Atomically advances the subscription's lifetime tier counter and writes its earning. D1's
 * batch is transactional, preventing concurrent webhook deliveries from losing an increment.
 * The caller must deduplicate provider payment events before invoking this operation.
 */
export async function settleTemplateSubscriptionPayment(
  db: D1Database,
  spaceId: string,
  grossCents: number,
  providerEventId: string,
  providerSubscriptionId?: string | null
): Promise<SettlementResult> {
  if (!providerEventId || providerEventId.length > 255) throw new Error("providerEventId is required");
  const tier = tierForPlanPrice(grossCents);
  const prior = await db.prepare("SELECT id, template_subscription_id, tier, cycle_number, gross_cents, developer_cents, platform_cents FROM developer_earnings_ledger WHERE provider_event_id = ?")
    .bind(providerEventId).first<{ id: string; template_subscription_id: string; tier: SettlementTier; cycle_number: number; gross_cents: number; developer_cents: number; platform_cents: number }>();
  if (prior) return { ledgerId: prior.id, subscriptionId: prior.template_subscription_id, tier: prior.tier, cycle: prior.cycle_number,
    grossCents: prior.gross_cents, developerCents: prior.developer_cents, platformCents: prior.platform_cents, commissionEligible: prior.developer_cents > 0 };
  const subscription = await db
    .prepare(
      `SELECT id, developer_user_id, attribution_channel, paid_cycles_total, pioneer_eligible
     FROM template_subscriptions WHERE space_id = ? AND status IN ('active','paused')
     ORDER BY updated_at DESC LIMIT 1`
    )
    .bind(spaceId)
    .first<{
      id: string;
      developer_user_id: string;
      attribution_channel: AttributionChannel;
      paid_cycles_total: number;
      pioneer_eligible: number;
    }>();
  if (!subscription)
    throw new Error(`No active template subscription for space ${spaceId}`);
  if (
    subscription.attribution_channel !== "DEVELOPER_REFERRAL" &&
    subscription.attribution_channel !== "MARKETPLACE_ORGANIC"
  ) {
    throw new Error("Invalid attribution channel");
  }

  const column = `cycles_paid_${tier}_tier`;
  const ledgerId = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE template_subscriptions SET ${column} = ${column} + 1, paid_cycles_total = paid_cycles_total + 1, status = 'active',
         provider_subscription_id = COALESCE(provider_subscription_id, ?), updated_at = datetime('now')
         WHERE id = ? AND status IN ('active','paused') AND NOT EXISTS (SELECT 1 FROM developer_earnings_ledger WHERE provider_event_id = ?)`
      )
      .bind(providerSubscriptionId ?? null, subscription.id, providerEventId),
    db
      .prepare(
        `INSERT INTO developer_earnings_ledger
       (id, template_subscription_id, space_id, developer_user_id, attribution_channel, tier, cycle_number, gross_cents, developer_cents, platform_cents, provider_event_id)
       SELECT ?, id, space_id, developer_user_id, attribution_channel, ?, paid_cycles_total, ?,
              CAST((? * CASE WHEN paid_cycles_total <= 6 AND pioneer_eligible = 1 THEN 4000
                             WHEN paid_cycles_total <= 6 THEN 2500
                             WHEN paid_cycles_total <= 12 THEN 2000 ELSE 500 END) / 10000 AS INTEGER),
              ? - CAST((? * CASE WHEN paid_cycles_total <= 6 AND pioneer_eligible = 1 THEN 4000
                                  WHEN paid_cycles_total <= 6 THEN 2500
                                  WHEN paid_cycles_total <= 12 THEN 2000 ELSE 500 END) / 10000 AS INTEGER), ?
       FROM template_subscriptions WHERE id = ? AND status = 'active' AND NOT EXISTS (SELECT 1 FROM developer_earnings_ledger WHERE provider_event_id = ?)`
      )
      .bind(
        ledgerId,
        tier,
        grossCents,
        grossCents,
        grossCents,
        grossCents,
        providerEventId,
        subscription.id,
        providerEventId,
      ),
  ]);
  if (!results[1]?.success || Number(results[1]?.meta?.changes ?? 0) !== 1) {
    const replay = await db.prepare("SELECT id, template_subscription_id, tier, cycle_number, gross_cents, developer_cents, platform_cents FROM developer_earnings_ledger WHERE provider_event_id = ?")
      .bind(providerEventId).first<{ id: string; template_subscription_id: string; tier: SettlementTier; cycle_number: number; gross_cents: number; developer_cents: number; platform_cents: number }>();
    if (replay) return { ledgerId: replay.id, subscriptionId: replay.template_subscription_id, tier: replay.tier, cycle: replay.cycle_number,
      grossCents: replay.gross_cents, developerCents: replay.developer_cents, platformCents: replay.platform_cents, commissionEligible: replay.developer_cents > 0 };
    throw new Error("Failed to record captured developer earning");
  }
  const row = await db
    .prepare(
      "SELECT cycle_number, developer_cents, platform_cents FROM developer_earnings_ledger WHERE id = ?"
    )
    .bind(ledgerId)
    .first<{
      cycle_number: number;
      developer_cents: number;
      platform_cents: number;
    }>();
  if (!row) throw new Error("Settlement ledger entry was not persisted");
  return {
    ledgerId,
    subscriptionId: subscription.id,
    tier,
    cycle: row.cycle_number,
    grossCents,
    developerCents: row.developer_cents,
    platformCents: row.platform_cents,
    commissionEligible: row.developer_cents > 0,
  };
}
