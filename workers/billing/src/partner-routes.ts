import type { Hono } from "hono";
import {
  badRequest,
  errorResponse,
  notFound,
  requireInternalHmac,
} from "@naelao/http";
import {
  settleTemplateSubscriptionPayment,
  settleOneOffTemplatePurchase,
  getPartnerEarningsSummary,
  getMaxCommissionCycles,
  verifyFeatureAccess,
  type AttributionChannel,
  type MonetizationType,
  type MonetizationModel,
  type TierAccessRules,
  type TemplateFeatureGating,
} from "@naelao/billing-core";
import type { BillingEnv } from "./index.js";

export function registerPartnerRoutes(app: Hono<{ Bindings: BillingEnv }>) {
  // ── POST /internal/partner/subscribe-template ──
  // Registers a client space's template subscription and attribution channel
  app.post("/internal/partner/subscribe-template", async (c) => {
    const authorized = await requireInternalHmac(
      c.req.raw,
      c.env.PLATFORM_SECRET,
      c.req.header("x-naelao-tenant-id") || "system"
    );
    if (!authorized) {
      return c.json({ error_code: "unauthorized", message: "Invalid internal HMAC signature" }, 401);
    }

    const body = await c.req.json<{
      spaceId: string;
      templateId: string;
      developerUserId: string;
      attributionChannel: AttributionChannel;
      monthlySubCents: number;
    }>().catch(() => null);

    if (!body || !body.spaceId || !body.templateId || !body.developerUserId || !body.attributionChannel) {
      return badRequest("Missing required fields: spaceId, templateId, developerUserId, attributionChannel");
    }

    const maxCycles = getMaxCommissionCycles(body.monthlySubCents || 0);
    const devSplitPct =
      body.attributionChannel === "DEVELOPER_REFERRAL" ? 40.0 :
      body.attributionChannel === "MARKETPLACE_ORGANIC" ? 20.0 : 0.0;

    const subId = `tsub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO template_subscriptions (
        id, space_id, template_id, developer_user_id, attribution_channel,
        monthly_sub_cents, developer_split_pct, billing_cycle_count,
        cycles_paid_entry_tier, cycles_paid_growth_tier, cycles_paid_pro_tier,
        max_commission_cycles, last_billed_plan_price_cents, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, 'active')
      ON CONFLICT(space_id) DO UPDATE SET
        template_id = excluded.template_id,
        developer_user_id = excluded.developer_user_id,
        attribution_channel = excluded.attribution_channel,
        monthly_sub_cents = excluded.monthly_sub_cents,
        developer_split_pct = excluded.developer_split_pct,
        max_commission_cycles = excluded.max_commission_cycles,
        last_billed_plan_price_cents = excluded.last_billed_plan_price_cents,
        status = 'active',
        updated_at = datetime('now')`
    )
      .bind(
        subId,
        body.spaceId,
        body.templateId,
        body.developerUserId,
        body.attributionChannel,
        body.monthlySubCents || 0,
        devSplitPct,
        maxCycles,
        body.monthlySubCents || 0
      )
      .run();

    return c.json({
      ok: true,
      subscription_id: subId,
      space_id: body.spaceId,
      attribution_channel: body.attributionChannel,
      developer_split_pct: devSplitPct,
      max_commission_cycles: maxCycles,
    });
  });

  // ── POST /internal/partner/settle-subscription ──
  // Triggered on successful monthly subscription invoice
  app.post("/internal/partner/settle-subscription", async (c) => {
    const authorized = await requireInternalHmac(
      c.req.raw,
      c.env.PLATFORM_SECRET,
      c.req.header("x-naelao-tenant-id") || "system"
    );
    if (!authorized) {
      return c.json({ error_code: "unauthorized", message: "Invalid internal HMAC signature" }, 401);
    }

    const body = await c.req.json<{
      spaceId: string;
      grossCents: number;
      period?: string;
    }>().catch(() => null);

    if (!body || !body.spaceId || body.grossCents === undefined) {
      return badRequest("Missing spaceId or grossCents");
    }

    const res = await settleTemplateSubscriptionPayment(
      c.env.PLATFORM_DB,
      body.spaceId,
      body.grossCents,
      body.period
    );

    if (!res) {
      return c.json({ ok: false, message: "No active template subscription found for spaceId" }, 404);
    }

    return c.json({ ok: true, settlement: res });
  });

  // ── POST /internal/partner/settle-one-off ──
  // Triggered on one-off template buy-out purchase
  app.post("/internal/partner/settle-one-off", async (c) => {
    const authorized = await requireInternalHmac(
      c.req.raw,
      c.env.PLATFORM_SECRET,
      c.req.header("x-naelao-tenant-id") || "system"
    );
    if (!authorized) {
      return c.json({ error_code: "unauthorized", message: "Invalid internal HMAC signature" }, 401);
    }

    const body = await c.req.json<{
      spaceId: string;
      templateId: string;
      developerUserId: string;
      grossCents: number;
      period?: string;
    }>().catch(() => null);

    if (!body || !body.spaceId || !body.templateId || !body.developerUserId || body.grossCents === undefined) {
      return badRequest("Missing spaceId, templateId, developerUserId, or grossCents");
    }

    const res = await settleOneOffTemplatePurchase(
      c.env.PLATFORM_DB,
      body.spaceId,
      body.templateId,
      body.developerUserId,
      body.grossCents,
      body.period
    );

    return c.json({ ok: true, settlement: res });
  });

  // ── POST /billing/partner/register ──
  // Developer partner onboarding & payout profile
  app.post("/billing/partner/register", async (c) => {
    const userId = c.req.header("x-naelao-user-id");
    if (!userId) {
      return c.json({ error_code: "unauthorized", message: "Missing user credentials" }, 401);
    }

    const body = await c.req.json<{
      displayName: string;
      payoutEmail: string;
      payoutDestinationJson?: string;
      commissionRatePct?: number;
    }>().catch(() => null);

    if (!body || !body.displayName || !body.payoutEmail) {
      return badRequest("Missing displayName or payoutEmail");
    }

    const partnerId = `dev_${userId.slice(0, 8)}_${Math.random().toString(36).slice(2, 6)}`;
    const commissionPct = body.commissionRatePct || 50.0;

    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO partner_accounts (
        id, user_id, display_name, payout_email, payout_destination_json, commission_rate_pct
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        display_name = excluded.display_name,
        payout_email = excluded.payout_email,
        payout_destination_json = COALESCE(excluded.payout_destination_json, partner_accounts.payout_destination_json)`
    )
      .bind(
        partnerId,
        userId,
        body.displayName,
        body.payoutEmail,
        body.payoutDestinationJson || null,
        commissionPct
      )
      .run();

    const partner = await c.env.PLATFORM_DB.prepare(
      "SELECT * FROM partner_accounts WHERE user_id = ?"
    )
      .bind(userId)
      .first();

    return c.json({ ok: true, partner });
  });

  // ── GET /billing/partner/summary ──
  // Developer partner dashboard summary with client roster & cycle counts
  app.get("/billing/partner/summary", async (c) => {
    const userId = c.req.header("x-naelao-user-id");
    if (!userId) {
      return c.json({ error_code: "unauthorized", message: "Missing user credentials" }, 401);
    }

    const summary = await getPartnerEarningsSummary(c.env.PLATFORM_DB, userId);
    if (!summary) {
      return c.json({
        ok: true,
        registered: false,
        message: "User is not yet registered as a Developer Partner",
      });
    }

    return c.json({ ok: true, registered: true, summary });
  });

  // ── POST /billing/partner/templates/publish ──
  // Publishes partner template monetization settings and creates referral links
  // Enforces mutually exclusive monetization models:
  // - Model A: FREEMIUM_TIERED_SAAS ($0 upfront, feature gating permitted)
  // - Model B: FIXED_ONE_OFF_UNLOCKED (fixed upfront price, 100% features unlocked forever, 0 gating)
  app.post("/billing/partner/templates/publish", async (c) => {
    const userId = c.req.header("x-naelao-user-id");
    if (!userId) {
      return c.json({ error_code: "unauthorized", message: "Missing user credentials" }, 401);
    }

    let partner = await c.env.PLATFORM_DB.prepare(
      "SELECT * FROM partner_accounts WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ id: string; display_name: string }>();

    // Auto-create partner account if not exists
    if (!partner) {
      const partnerId = `dev_${userId.slice(0, 8)}`;
      await c.env.PLATFORM_DB.prepare(
        `INSERT INTO partner_accounts (id, user_id, display_name, payout_email)
         VALUES (?, ?, ?, ?)`
      )
        .bind(partnerId, userId, "Developer Partner", "partner@example.com")
        .run();
      partner = { id: partnerId, display_name: "Developer Partner" };
    }

    const body = await c.req.json<{
      templateId?: string;
      name: string;
      category: string;
      description: string;
      blueprintR2Key?: string;
      priceCentsMonthly?: number;
      priceCentsOneOff?: number;
      fixedPriceCents?: number;
      monetizationType?: MonetizationType;
      monetizationModel?: MonetizationModel;
      tierAccessRules?: TierAccessRules;
      isPublic?: boolean;
    }>().catch(() => null);

    if (!body || !body.name) {
      return badRequest("Missing template name");
    }

    const templateId = body.templateId || `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    
    // Resolve model: support both explicit monetizationModel and legacy monetizationType
    let model: MonetizationModel = "FREEMIUM_TIERED_SAAS";
    if (body.monetizationModel) {
      model = body.monetizationModel;
    } else if (body.monetizationType === "fixed_one_off") {
      model = "FIXED_ONE_OFF_UNLOCKED";
    }

    // Mutual exclusivity enforcement
    let fixedPriceCents = 0;
    let tierAccessRulesJson: string | null = null;
    let monthlyPrice = body.priceCentsMonthly !== undefined ? body.priceCentsMonthly : 9900;
    const monetizationType: MonetizationType = model === "FIXED_ONE_OFF_UNLOCKED" ? "fixed_one_off" : "subscription";

    if (model === "FIXED_ONE_OFF_UNLOCKED") {
      // Fixed buy-out: upfront price required, gating rules disabled (all features 100% unlocked)
      fixedPriceCents = body.fixedPriceCents || body.priceCentsOneOff || 9900;
      tierAccessRulesJson = null;
    } else {
      // Freemium tiered SaaS: upfront install is $0, gating rules permitted
      fixedPriceCents = 0;
      if (body.tierAccessRules) {
        tierAccessRulesJson = JSON.stringify(body.tierAccessRules);
      }
    }

    const isPublic = body.isPublic ? 1 : 0;
    const r2Key = body.blueprintR2Key || `blueprints/${templateId}.json`;

    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO partner_templates (
        id, partner_id, name, category, description, blueprint_r2_key,
        price_cents_monthly, price_cents_one_off, fixed_price_cents,
        monetization_type, monetization_model, tier_access_rules_json, is_public
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        description = excluded.description,
        price_cents_monthly = excluded.price_cents_monthly,
        price_cents_one_off = excluded.price_cents_one_off,
        fixed_price_cents = excluded.fixed_price_cents,
        monetization_type = excluded.monetization_type,
        monetization_model = excluded.monetization_model,
        tier_access_rules_json = excluded.tier_access_rules_json,
        is_public = excluded.is_public`
    )
      .bind(
        templateId,
        partner.id,
        body.name,
        body.category || "agency",
        body.description || "",
        r2Key,
        monthlyPrice,
        fixedPriceCents,
        fixedPriceCents,
        monetizationType,
        model,
        tierAccessRulesJson,
        isPublic
      )
      .run();

    const referralUrl = `https://app.naelao.com/join?template=${templateId}&partner=${partner.id}`;

    return c.json({
      ok: true,
      template_id: templateId,
      partner_id: partner.id,
      monetization_model: model,
      monetization_type: monetizationType,
      monthly_price_cents: monthlyPrice,
      fixed_price_cents: fixedPriceCents,
      referral_url: referralUrl,
      feature_gating_enabled: model === "FREEMIUM_TIERED_SAAS",
      commission_breakdown: {
        referral_direct_split_pct: model === "FREEMIUM_TIERED_SAAS" ? 40 : 0,
        organic_marketplace_split_pct: model === "FREEMIUM_TIERED_SAAS" ? 20 : 0,
        fixed_upfront_split_pct: model === "FIXED_ONE_OFF_UNLOCKED" ? 100 : 0,
        duration_policy:
          model === "FIXED_ONE_OFF_UNLOCKED"
            ? "100% Upfront Payout (0% on platform monthly hosting)"
            : monthlyPrice < 5000
            ? "6 Months Only (Entry Tier)"
            : monthlyPrice < 15000
            ? "12 Months (Growth Tier)"
            : "Lifetime Recurring (Pro Tier $150+/mo)",
      },
    });
  });

  // ── GET /billing/partner/verify-access ──
  // Checks if a workstation or project kind is accessible under a given plan
  app.get("/billing/partner/verify-access", async (c) => {
    const spaceId = c.req.query("spaceId");
    const requestedProjectKind = c.req.query("projectKind");
    const planPriceUsd = parseFloat(c.req.query("planPriceUsd") || "20");

    if (!requestedProjectKind) {
      return badRequest("Missing projectKind query parameter");
    }

    if (!spaceId) {
      return c.json({ allowed: true });
    }

    // Lookup template gating if space is bound to a partner template
    const sub = await c.env.PLATFORM_DB.prepare(
      `SELECT t.monetization_model, t.tier_access_rules_json 
       FROM template_subscriptions ts
       JOIN partner_templates t ON ts.template_id = t.id
       WHERE ts.space_id = ?`
    )
      .bind(spaceId)
      .first<{ monetization_model: MonetizationModel; tier_access_rules_json: string | null }>();

    if (!sub || sub.monetization_model === "FIXED_ONE_OFF_UNLOCKED" || !sub.tier_access_rules_json) {
      return c.json({ allowed: true });
    }

    try {
      const tierAccessRules = JSON.parse(sub.tier_access_rules_json) as TierAccessRules;
      const check = verifyFeatureAccess(planPriceUsd, requestedProjectKind, {
        monetizationModel: sub.monetization_model,
        tierAccessRules,
      });
      return c.json(check);
    } catch {
      return c.json({ allowed: true });
    }
  });
}
