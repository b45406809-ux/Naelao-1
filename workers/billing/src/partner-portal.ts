import {
  PriceBelowWholesaleFloorError,
  type PriceFloorResult,
  type WholesaleExtension,
  validatePriceFloor,
} from "@naelao/billing-core";
import type { Hono } from "hono";
import type { BillingEnv } from "./index.js";
import { developerCommissionBps } from "./settlement.js";
import { reserveDeveloperPayout } from "./payout-reconciliation.js";
import { createLsProductVariant } from "./ls-products.js";
import { LemonSqueezyProvider } from "@naelao/billing-core";

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
  const profile = await db.prepare("SELECT user_id FROM developer_partner_profiles WHERE user_id = ? AND status = 'active'")
    .bind(input.developer_user_id).first<{ user_id: string }>();
  if (!profile) throw new Error("developer_profile_required");
  return {
    developerId: profile.user_id,
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
    const parsed = await c.req.json<unknown>().catch(() => null);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return c.json({ error_code: "bad_request" }, 400);
    const input = parsed as Partial<TemplateSubscriptionInput>;
    const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;
    if (!text(input.space_id, 128) || !text(input.template_id, 128) ||
        !Number.isSafeInteger(input.plan_price_cents) || input.plan_price_cents! <= 0 ||
        !Number.isSafeInteger(input.requested_price_cents) || input.requested_price_cents! <= 0 ||
        (input.developer_user_id !== undefined && !text(input.developer_user_id, 128)) ||
        (input.ref !== undefined && !text(input.ref, 64)) ||
        (input.extensions !== undefined && (!Array.isArray(input.extensions) || input.extensions.length > 64 || input.extensions.some(extension => !extension || !Number.isSafeInteger(extension.wholesaleFeeCents) || extension.wholesaleFeeCents < 0 || (extension.id !== undefined && !text(extension.id, 128)))))) {
      return c.json({ error_code: "bad_request" }, 400);
    }
    const validInput = input as TemplateSubscriptionInput;
    const owned = await c.env.PLATFORM_DB.prepare(
      "SELECT id FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
    )
      .bind(validInput.space_id, tenantId)
      .first();
    if (!owned)
      return c.json(
        { error_code: "not_found", message: "Space not found" },
        404
      );
    let floor: PriceFloorResult;
    try {
      floor = validatePriceFloor({
        planPriceCents: validInput.plan_price_cents,
        extensions: validInput.extensions ?? [],
        requestedPriceCents: validInput.requested_price_cents,
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
      attribution = await resolveDeveloperAttribution(c.env.PLATFORM_DB, validInput);
    } catch (error) {
      return c.json(
        {
          error_code: String((error as Error).message),
          message: "Referral or developer attribution is invalid",
        },
        400
      );
    }
    if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID) return c.json({ error_code: "billing_provider_unavailable" }, 503);
    const id = crypto.randomUUID();
    const partner = await c.env.PLATFORM_DB.prepare("SELECT pioneer_rank FROM developer_partner_profiles WHERE user_id = ? AND status = 'active'")
      .bind(attribution.developerId).first<{ pioneer_rank: number | null }>();
    const pioneerEligible = partner?.pioneer_rank !== null && Number(partner?.pioneer_rank) <= 50;
    let product: Awaited<ReturnType<typeof createLsProductVariant>>;
    let checkoutUrl: string;
    try {
      product = await createLsProductVariant({ apiKey: c.env.LEMON_SQUEEZY_API_KEY, storeId: c.env.LEMON_SQUEEZY_STORE_ID }, {
        name: `Naelao template ${validInput.template_id}`.slice(0, 100),
        description: "Monthly Naelao template subscription",
        price_cents: validInput.requested_price_cents,
        kind: "subscription",
      });
      const provider = new LemonSqueezyProvider({ LEMON_SQUEEZY_API_KEY: c.env.LEMON_SQUEEZY_API_KEY, LEMON_SQUEEZY_STORE_ID: c.env.LEMON_SQUEEZY_STORE_ID });
      const checkout = await provider.createCheckout({
        spaceId: validInput.space_id,
        variantOrPriceId: product.lsVariantId,
        metadata: { kind: "template_subscription", template_subscription_id: id },
      });
      checkoutUrl = checkout.url;
    } catch (error) {
      console.error("template subscription checkout provisioning failed", (error as Error).message.slice(0, 300));
      return c.json({ error_code: "template_checkout_unavailable" }, 503);
    }
    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO template_subscriptions
       (id, space_id, template_id, developer_user_id, attribution_channel, base_plan_price_cents, first_month_price_cents, extension_wholesale_cents, pioneer_eligible, ls_product_id, ls_variant_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paused')`
    )
      .bind(
        id,
        validInput.space_id,
        validInput.template_id,
        attribution.developerId,
        attribution.channel,
        validInput.plan_price_cents,
        validInput.requested_price_cents,
        floor.floorCents - validInput.plan_price_cents,
        pioneerEligible ? 1 : 0,
        product.lsProductId,
        product.lsVariantId,
      )
      .run();
    return c.json(
      {
        id,
        attribution_channel: attribution.channel,
        developer_user_id: attribution.developerId,
        wholesale_floor_cents: floor.floorCents,
        commission_bps: pioneerEligible ? 4_000 : developerCommissionBps(attribution.channel),
        checkout_url: checkoutUrl,
        status: "pending_payment",
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
      `SELECT COALESCE(SUM(amount_cents), 0) AS lifetime_cents,
              COALESCE(SUM(CASE WHEN payout_id IS NULL THEN amount_cents ELSE 0 END), 0) AS pending_cents
       FROM (
         SELECT developer_cents AS amount_cents, payout_id FROM developer_earnings_ledger WHERE developer_user_id = ?
         UNION ALL SELECT amount_cents, payout_id FROM developer_license_earnings WHERE developer_user_id = ?
       )`
    )
      .bind(userId, userId)
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
    const reserved = await reserveDeveloperPayout(c.env.PLATFORM_DB, userId);
    if (!reserved)
      return c.json(
        {
          error_code: "no_pending_earnings",
          message: "There are no pending earnings to withdraw",
        },
        400
      );
    return c.json(
      { ...reserved, currency: "USD", status: "queued" },
      202
    );
  });

  app.put("/billing/partner/auto-payout", async c => {
    const userId = c.req.header("x-naelao-user-id") ?? "";
    if (!userId) return c.json({ error_code: "unauthorized" }, 401);
    const body = await c.req.json<unknown>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error_code: "bad_request" }, 400);
    const enabled = (body as { enabled?: unknown }).enabled;
    if (typeof enabled !== "boolean") return c.json({ error_code: "bad_request" }, 400);
    const result = await c.env.PLATFORM_DB.prepare("UPDATE developer_partner_profiles SET auto_payout_enabled = ? WHERE user_id = ? AND status = 'active' RETURNING user_id").bind(enabled ? 1 : 0, userId).first();
    return result ? c.json({ enabled }) : c.json({ error_code: "partner_profile_required" }, 404);
  });
}
