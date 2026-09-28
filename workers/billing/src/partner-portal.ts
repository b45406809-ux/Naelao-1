import {
  PriceBelowWholesaleFloorError,
  type PriceFloorResult,
  type WholesaleExtension,
  validatePriceFloor,
} from "@naelao/billing-core";
import type { Hono } from "hono";
import type { BillingEnv } from "./index.js";

export interface TemplateSubscriptionInput {
  space_id: string;
  template_id: string;
  developer_user_id?: string;
  ref?: string;
  plan_price_cents: number;
  requested_price_cents: number;
  extensions?: WholesaleExtension[];
}

export async function resolveDeveloperAttribution(
  db: D1Database,
  input: TemplateSubscriptionInput
): Promise<{
  developerId: string;
  channel: "DEVELOPER_REFERRAL" | "MARKETPLACE_ORGANIC";
}> {
  if (input.ref) {
    const profile = await db
      .prepare(
        "SELECT user_id FROM developer_partner_profiles WHERE handle = ? COLLATE NOCASE AND status = 'active'"
      )
      .bind(input.ref)
      .first<{ user_id: string }>();
    if (!profile) throw new Error("invalid_referral_code");
    return { developerId: profile.user_id, channel: "DEVELOPER_REFERRAL" };
  }
  if (!input.developer_user_id) throw new Error("developer_user_id_required");
  return {
    developerId: input.developer_user_id,
    channel: "MARKETPLACE_ORGANIC",
  };
}

export function registerPartnerPortalRoutes(
  app: Hono<{ Bindings: BillingEnv }>
): void {
  app.post("/billing/template-subscriptions", async (c) => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    if (!tenantId)
      return c.json(
        { error_code: "unauthorized", message: "Missing tenant" },
        401
      );
    const input = await c.req.json<TemplateSubscriptionInput>();
    const owned = await c.env.PLATFORM_DB.prepare(
      "SELECT id FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
    )
      .bind(input.space_id, tenantId)
      .first();
    if (!owned)
      return c.json(
        { error_code: "not_found", message: "Space not found" },
        404
      );
    let floor: PriceFloorResult;
    try {
      floor = validatePriceFloor({
        planPriceCents: input.plan_price_cents,
        extensions: input.extensions ?? [],
        requestedPriceCents: input.requested_price_cents,
      });
    } catch (error) {
      if (error instanceof PriceBelowWholesaleFloorError)
        return c.json(
          {
            error_code: error.errorCode,
            message: error.message,
            floor_cents: error.floorCents,
            requested_price_cents: error.requestedPriceCents,
          },
          400
        );
      throw error;
    }
    let attribution: Awaited<ReturnType<typeof resolveDeveloperAttribution>>;
    try {
      attribution = await resolveDeveloperAttribution(c.env.PLATFORM_DB, input);
    } catch (error) {
      return c.json(
        {
          error_code: String((error as Error).message),
          message: "Referral or developer attribution is invalid",
        },
        400
      );
    }
    const id = crypto.randomUUID();
    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO template_subscriptions
       (id, space_id, template_id, developer_user_id, attribution_channel, base_plan_price_cents, first_month_price_cents, extension_wholesale_cents, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
    )
      .bind(
        id,
        input.space_id,
        input.template_id,
        attribution.developerId,
        attribution.channel,
        input.plan_price_cents,
        input.requested_price_cents,
        floor.floorCents - input.plan_price_cents
      )
      .run();
    return c.json(
      {
        id,
        attribution_channel: attribution.channel,
        developer_user_id: attribution.developerId,
        wholesale_floor_cents: floor.floorCents,
        commission_bps:
          attribution.channel === "DEVELOPER_REFERRAL" ? 4_000 : 2_000,
      },
      201
    );
  });

  app.get("/billing/partner/portfolio", async (c) => {
    const userId = c.req.header("x-naelao-user-id") ?? "";
    if (!userId)
      return c.json(
        { error_code: "unauthorized", message: "Missing user" },
        401
      );
    const { results } = await c.env.PLATFORM_DB.prepare(
      `SELECT ts.id AS subscription_id, ts.space_id, s.name AS space_name, ts.template_id,
              ts.attribution_channel, ts.status, ts.first_month_price_cents AS plan_price_cents,
              ts.cycles_paid_entry_tier, ts.cycles_paid_growth_tier, ts.cycles_paid_pro_tier
       FROM template_subscriptions ts JOIN spaces s ON s.id = ts.space_id
       WHERE ts.developer_user_id = ? ORDER BY ts.updated_at DESC`
    )
      .bind(userId)
      .all<Record<string, unknown>>();
    const balance = await c.env.PLATFORM_DB.prepare(
      `SELECT COALESCE(SUM(developer_cents), 0) AS lifetime_cents,
              COALESCE(SUM(CASE WHEN payout_id IS NULL THEN developer_cents ELSE 0 END), 0) AS pending_cents
       FROM developer_earnings_ledger WHERE developer_user_id = ?`
    )
      .bind(userId)
      .first<{ lifetime_cents: number; pending_cents: number }>();
    return c.json({
      clients: results.map((row) => ({
        ...row,
        remaining_commission_cycles: {
          entry: Math.max(0, 6 - Number(row.cycles_paid_entry_tier)),
          growth: Math.max(0, 12 - Number(row.cycles_paid_growth_tier)),
          pro: null,
        },
      })),
      earnings: {
        pending_cents: balance?.pending_cents ?? 0,
        lifetime_cents: balance?.lifetime_cents ?? 0,
        currency: "USD",
      },
    });
  });

  app.post("/billing/partner/withdrawals", async (c) => {
    const userId = c.req.header("x-naelao-user-id") ?? "";
    if (!userId)
      return c.json(
        { error_code: "unauthorized", message: "Missing user" },
        401
      );
    const pending = await c.env.PLATFORM_DB.prepare(
      "SELECT COALESCE(SUM(developer_cents), 0) AS cents FROM developer_earnings_ledger WHERE developer_user_id = ? AND payout_id IS NULL"
    )
      .bind(userId)
      .first<{ cents: number }>();
    const amount = pending?.cents ?? 0;
    if (amount <= 0)
      return c.json(
        {
          error_code: "no_pending_earnings",
          message: "There are no pending earnings to withdraw",
        },
        400
      );
    const payoutId = crypto.randomUUID();
    await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare(
        "INSERT INTO developer_payouts (id, developer_user_id, amount_cents, status) VALUES (?, ?, ?, 'queued')"
      ).bind(payoutId, userId, amount),
      c.env.PLATFORM_DB.prepare(
        "UPDATE developer_earnings_ledger SET payout_id = ? WHERE developer_user_id = ? AND payout_id IS NULL"
      ).bind(payoutId, userId),
    ]);
    return c.json(
      { id: payoutId, amount_cents: amount, currency: "USD", status: "queued" },
      202
    );
  });
}
