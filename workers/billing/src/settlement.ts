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
  return channel === "DEVELOPER_REFERRAL" ? 4_000 : 2_000;
}

export function calculateDeveloperCommission(
  grossCents: number,
  channel: AttributionChannel,
  tier: SettlementTier,
  cycle: number
): number {
  const eligible =
    tier === "pro" || (tier === "entry" ? cycle <= 6 : cycle <= 12);
  return eligible
    ? Math.floor((grossCents * developerCommissionBps(channel)) / 10_000)
    : 0;
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
  grossCents: number
): Promise<SettlementResult> {
  const tier = tierForPlanPrice(grossCents);
  const subscription = await db
    .prepare(
      `SELECT id, developer_user_id, attribution_channel
     FROM template_subscriptions WHERE space_id = ? AND status = 'active'
     ORDER BY updated_at DESC LIMIT 1`
    )
    .bind(spaceId)
    .first<{
      id: string;
      developer_user_id: string;
      attribution_channel: AttributionChannel;
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
  const bps = developerCommissionBps(subscription.attribution_channel);
  const limit = tier === "entry" ? 6 : tier === "growth" ? 12 : null;
  const eligibilitySql = limit === null ? "1" : `${column} <= ${limit}`;
  const [, ledgerWrite] = await db.batch([
    db
      .prepare(
        `UPDATE template_subscriptions SET ${column} = ${column} + 1, updated_at = datetime('now') WHERE id = ?`
      )
      .bind(subscription.id),
    db
      .prepare(
        `INSERT INTO developer_earnings_ledger
       (id, template_subscription_id, space_id, developer_user_id, attribution_channel, tier, cycle_number, gross_cents, developer_cents, platform_cents)
       SELECT ?, id, space_id, developer_user_id, attribution_channel, ?, ${column}, ?,
              CASE WHEN ${eligibilitySql} THEN CAST((? * ?) / 10000 AS INTEGER) ELSE 0 END,
              ? - CASE WHEN ${eligibilitySql} THEN CAST((? * ?) / 10000 AS INTEGER) ELSE 0 END
       FROM template_subscriptions WHERE id = ?`
      )
      .bind(
        ledgerId,
        tier,
        grossCents,
        grossCents,
        bps,
        grossCents,
        grossCents,
        bps,
        subscription.id
      ),
  ]);
  if (!ledgerWrite?.success)
    throw new Error("Failed to record developer earning");
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
