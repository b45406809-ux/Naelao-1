import { describe, it, expect } from "vitest";
import {
  computeDeveloperCommissionSplit,
  getMaxCommissionCycles,
  isCommissionCycleEligible,
  settleTemplateSubscriptionPayment,
  settleOneOffTemplatePurchase,
  getPartnerEarningsSummary,
  verifyFeatureAccess,
} from "@naelao/billing-core";
import { mintInternalToken } from "@naelao/http";
import billingWorker from "../../workers/billing/src/index.js";

const PLATFORM_SECRET = "test-partner-secret";

async function loadTestDb() {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { createFakeD1 } = await import("../stubs/d1-sqlite.js");
  const m = (f: string) => readFileSync(join(__dirname, "../../infra/migrations/", f), "utf8");

  const fakeDb = createFakeD1([
    m("0001_users.sql"),
    m("0004_billing.sql"),
    m("0033_reseller_accounts.sql"),
    m("0035_commerce.sql"),
    m("0075_partner_portal_and_duration_splits.sql"),
  ]);

  return fakeDb;
}

describe("Developer Partner Portal: Revenue Splits & Tier-Based Duration Settlement", () => {
  describe("1. Pure Calculation & Duration Constraint Logic", () => {
    it("assigns 6 months max for Entry Tier (< $50/mo)", () => {
      expect(getMaxCommissionCycles(2000)).toBe(6); // $20/mo -> 6 cycles
      expect(getMaxCommissionCycles(4900)).toBe(6); // $49/mo -> 6 cycles
    });

    it("assigns 12 months max for Growth Tier ($50 to < $150/mo)", () => {
      expect(getMaxCommissionCycles(5000)).toBe(12); // $50/mo -> 12 cycles
      expect(getMaxCommissionCycles(14900)).toBe(12); // $149/mo -> 12 cycles
    });

    it("assigns Lifetime Recurring (null) for Pro Tier ($150+/mo)", () => {
      expect(getMaxCommissionCycles(15000)).toBeNull(); // $150/mo -> unlimited
      expect(getMaxCommissionCycles(50000)).toBeNull(); // $500/mo -> unlimited
    });

    it("evaluates cycle eligibility correctly", () => {
      expect(isCommissionCycleEligible(1, 6)).toBe(true);
      expect(isCommissionCycleEligible(6, 6)).toBe(true);
      expect(isCommissionCycleEligible(7, 6)).toBe(false); // expired

      expect(isCommissionCycleEligible(12, 12)).toBe(true);
      expect(isCommissionCycleEligible(13, 12)).toBe(false); // expired

      expect(isCommissionCycleEligible(100, null)).toBe(true); // lifetime
    });

    it("calculates Scenario 1: Developer Referral (Direct Link/QR) -> 40% cut", () => {
      // Pro Tier $150/mo -> $60/mo developer cut, $90/mo platform cut
      const split = computeDeveloperCommissionSplit({
        attributionChannel: "DEVELOPER_REFERRAL",
        grossCents: 15000,
        cycleCount: 1,
      });
      expect(split.developerRate).toBe(0.40);
      expect(split.developerCutCents).toBe(6000); // $60.00
      expect(split.platformCutCents).toBe(9000); // $90.00
      expect(split.isEligible).toBe(true);
      expect(split.remainingCycles).toBeNull();
    });

    it("calculates Scenario 2: Organic Marketplace Discovery -> 20% royalty", () => {
      // Pro Tier $150/mo -> $30/mo developer cut, $120/mo platform cut
      const split = computeDeveloperCommissionSplit({
        attributionChannel: "MARKETPLACE_ORGANIC",
        grossCents: 15000,
        cycleCount: 1,
      });
      expect(split.developerRate).toBe(0.20);
      expect(split.developerCutCents).toBe(3000); // $30.00
      expect(split.platformCutCents).toBe(12000); // $120.00
      expect(split.isEligible).toBe(true);
    });

    it("calculates Scenario 3: Fixed-Price Template Sale (Buy-Out) -> 0% ongoing monthly", () => {
      const split = computeDeveloperCommissionSplit({
        attributionChannel: "FIXED_ONE_OFF",
        grossCents: 2900,
        cycleCount: 1,
      });
      expect(split.developerRate).toBe(0.0);
      expect(split.developerCutCents).toBe(0);
      expect(split.platformCutCents).toBe(2900); // Platform keeps 100% of ongoing base hosting
      expect(split.isEligible).toBe(false);
    });

    it("enforces Entry Tier ($20/mo) duration expiration after month 6", () => {
      // Month 1 to 6: 40% = $8.00/mo
      const month5 = computeDeveloperCommissionSplit({
        attributionChannel: "DEVELOPER_REFERRAL",
        grossCents: 2000,
        cycleCount: 5,
        maxCommissionCycles: 6,
      });
      expect(month5.isEligible).toBe(true);
      expect(month5.developerCutCents).toBe(800); // $8.00
      expect(month5.remainingCycles).toBe(1);

      // Month 7: Expired -> $0 to developer, $20 (100%) to platform
      const month7 = computeDeveloperCommissionSplit({
        attributionChannel: "DEVELOPER_REFERRAL",
        grossCents: 2000,
        cycleCount: 7,
        maxCommissionCycles: 6,
      });
      expect(month7.isEligible).toBe(false);
      expect(month7.developerCutCents).toBe(0);
      expect(month7.platformCutCents).toBe(2000);
      expect(month7.remainingCycles).toBe(0);
    });

    it("enforces Growth Tier ($50/mo) duration expiration after month 12", () => {
      const month12 = computeDeveloperCommissionSplit({
        attributionChannel: "DEVELOPER_REFERRAL",
        grossCents: 5000,
        cycleCount: 12,
        maxCommissionCycles: 12,
      });
      expect(month12.isEligible).toBe(true);
      expect(month12.developerCutCents).toBe(2000); // $20.00
      expect(month12.remainingCycles).toBe(0);

      const month13 = computeDeveloperCommissionSplit({
        attributionChannel: "DEVELOPER_REFERRAL",
        grossCents: 5000,
        cycleCount: 13,
        maxCommissionCycles: 12,
      });
      expect(month13.isEligible).toBe(false);
      expect(month13.developerCutCents).toBe(0);
      expect(month13.platformCutCents).toBe(5000);
    });
  });

  describe("2. Database Settlement Execution with D1", () => {
    it("settles monthly subscription payments, increments cycle count, and logs to ledger", async () => {
      const fakeDb = await loadTestDb();

      // Create partner account
      await fakeDb.prepare(
        `INSERT INTO partner_accounts (id, user_id, display_name, payout_email, total_earned_cents, balance_cents)
         VALUES ('dev_john', 'user_john_101', 'John Developer', 'john@agency.com', 0, 0)`
      ).run();

      // Create template subscription ($150/mo Pro Tier)
      await fakeDb.prepare(
        `INSERT INTO template_subscriptions (
          id, space_id, template_id, developer_user_id, attribution_channel,
          monthly_sub_cents, developer_split_pct, billing_cycle_count, max_commission_cycles, status
        ) VALUES ('tsub_1', 'space_client_1', 'tpl_dental_1', 'user_john_101', 'DEVELOPER_REFERRAL', 15000, 40.0, 0, NULL, 'active')`
      ).run();

      // Settle cycle 1
      const res1 = await settleTemplateSubscriptionPayment(fakeDb as any, "space_client_1", 15000, "2026-08");
      expect(res1?.settled).toBe(true);
      expect(res1?.cycleCount).toBe(1);
      expect(res1?.developerCutCents).toBe(6000); // $60
      expect(res1?.platformCutCents).toBe(9000); // $90

      // Check partner account updated
      const partner1 = await fakeDb.prepare("SELECT * FROM partner_accounts WHERE user_id = 'user_john_101'").first<any>();
      expect(partner1.total_earned_cents).toBe(6000);
      expect(partner1.balance_cents).toBe(6000);

      // Check ledger entry
      const ledger1 = await fakeDb.prepare("SELECT * FROM developer_earnings_ledger WHERE developer_user_id = 'user_john_101'").first<any>();
      expect(ledger1).toMatchObject({
        space_id: "space_client_1",
        gross_cents: 15000,
        developer_cut_cents: 6000,
        platform_cut_cents: 9000,
        period: "2026-08",
      });

      // Settle cycle 2
      const res2 = await settleTemplateSubscriptionPayment(fakeDb as any, "space_client_1", 15000, "2026-09");
      expect(res2?.cycleCount).toBe(2);
      expect(res2?.developerCutCents).toBe(6000);

      const partner2 = await fakeDb.prepare("SELECT * FROM partner_accounts WHERE user_id = 'user_john_101'").first<any>();
      expect(partner2.total_earned_cents).toBe(12000); // $120 cumulative
      expect(partner2.balance_cents).toBe(12000);
    });

    it("settles fixed one-off template purchases with 100% upfront payout", async () => {
      const fakeDb = await loadTestDb();

      await fakeDb.prepare(
        `INSERT INTO partner_accounts (id, user_id, display_name, payout_email, total_earned_cents, balance_cents)
         VALUES ('dev_sarah', 'user_sarah_202', 'Sarah Agency', 'sarah@agency.com', 0, 0)`
      ).run();

      const res = await settleOneOffTemplatePurchase(
        fakeDb as any,
        "space_client_2",
        "tpl_legal_fixed",
        "user_sarah_202",
        9900, // $99.00
        "2026-08"
      );

      expect(res.settled).toBe(true);
      expect(res.developerCutCents).toBe(9900); // 100% to developer
      expect(res.platformCutCents).toBe(0);

      const partner = await fakeDb.prepare("SELECT * FROM partner_accounts WHERE user_id = 'user_sarah_202'").first<any>();
      expect(partner.total_earned_cents).toBe(9900);
      expect(partner.balance_cents).toBe(9900);

      const ledger = await fakeDb.prepare("SELECT * FROM developer_earnings_ledger WHERE developer_user_id = 'user_sarah_202'").first<any>();
      expect(ledger.event_type).toBe("one_off_license_sale");
      expect(ledger.gross_cents).toBe(9900);
    });

    it("provides full partner earnings summary with client roster & upgrade indicators", async () => {
      const fakeDb = await loadTestDb();

      await fakeDb.prepare(
        `INSERT INTO partner_accounts (id, user_id, display_name, payout_email, total_earned_cents, balance_cents)
         VALUES ('dev_alex', 'user_alex_303', 'Alex Dev', 'alex@dev.com', 5400, 5400)`
      ).run();

      // Client 1: $20 Entry tier at Month 5 of 6 (Upgrade pitch recommended!)
      await fakeDb.prepare(
        `INSERT INTO template_subscriptions (
          id, space_id, template_id, developer_user_id, attribution_channel,
          monthly_sub_cents, developer_split_pct, billing_cycle_count, max_commission_cycles, status
        ) VALUES ('tsub_a', 'space_a', 'tpl_bot_1', 'user_alex_303', 'DEVELOPER_REFERRAL', 2000, 40.0, 5, 6, 'active')`
      ).run();

      // Client 2: $150 Pro tier at Month 8 (Lifetime)
      await fakeDb.prepare(
        `INSERT INTO template_subscriptions (
          id, space_id, template_id, developer_user_id, attribution_channel,
          monthly_sub_cents, developer_split_pct, billing_cycle_count, max_commission_cycles, status
        ) VALUES ('tsub_b', 'space_b', 'tpl_pro_1', 'user_alex_303', 'DEVELOPER_REFERRAL', 15000, 40.0, 8, NULL, 'active')`
      ).run();

      const summary = await getPartnerEarningsSummary(fakeDb as any, "user_alex_303");
      expect(summary).not.toBeNull();
      expect(summary?.activeClientsCount).toBe(2);
      expect(summary?.monthlyRecurringCommissionCents).toBe(6800); // $8 ($20*40%) + $60 ($150*40%) = $68/mo

      const clientA = summary?.clientRoster.find((c) => c.spaceId === "space_a");
      expect(clientA?.tierName).toBe("Entry ($20/mo)");
      expect(clientA?.durationStatus).toBe("in_progress");
      expect(clientA?.remainingCycles).toBe(1);
      expect(clientA?.upgradePitchRecommended).toBe(true); // Month 5 of 6 triggers upgrade pitch!

      const clientB = summary?.clientRoster.find((c) => c.spaceId === "space_b");
      expect(clientB?.tierName).toBe("Pro ($150+/mo)");
      expect(clientB?.durationStatus).toBe("lifetime");
      expect(clientB?.remainingCycles).toBeNull();
      expect(clientB?.upgradePitchRecommended).toBe(false);
    });
  });

  describe("3. Billing Worker HTTP Route Endpoints", () => {
    it("handles /billing/partner/register and /billing/partner/summary", async () => {
      const fakeDb = await loadTestDb();
      const env = {
        PLATFORM_SECRET,
        PLATFORM_DB: fakeDb,
        QUOTA_CACHE: {} as any,
        BILLING_EVENTS: {} as any,
      };

      // Register partner
      const regReq = new Request("http://billing/billing/partner/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-naelao-user-id": "user_partner_404",
        },
        body: JSON.stringify({
          displayName: "TechCorp AI Solutions",
          payoutEmail: "payouts@techcorp.io",
        }),
      });

      const regRes = await billingWorker.fetch(regReq, env as any);
      expect(regRes.status).toBe(200);
      const regJson = await regRes.json<any>();
      expect(regJson.ok).toBe(true);
      expect(regJson.partner.display_name).toBe("TechCorp AI Solutions");

      // Fetch summary
      const sumReq = new Request("http://billing/billing/partner/summary", {
        headers: {
          "x-naelao-user-id": "user_partner_404",
        },
      });
      const sumRes = await billingWorker.fetch(sumReq, env as any);
      expect(sumRes.status).toBe(200);
      const sumJson = await sumRes.json<any>();
      expect(sumJson.registered).toBe(true);
      expect(sumJson.summary.displayName).toBe("TechCorp AI Solutions");
    });

    it("handles /billing/partner/templates/publish with monetization split calculations", async () => {
      const fakeDb = await loadTestDb();
      const env = {
        PLATFORM_SECRET,
        PLATFORM_DB: fakeDb,
        QUOTA_CACHE: {} as any,
        BILLING_EVENTS: {} as any,
      };

      const pubReq = new Request("http://billing/billing/partner/templates/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-naelao-user-id": "user_partner_404",
        },
        body: JSON.stringify({
          name: "Miami Clinic AI Receptionist",
          category: "healthcare",
          description: "Full clinic front desk automation",
          monetizationType: "subscription",
          priceCentsMonthly: 15000,
        }),
      });

      const pubRes = await billingWorker.fetch(pubReq, env as any);
      expect(pubRes.status).toBe(200);
      const pubJson = await pubRes.json<any>();
      expect(pubJson.ok).toBe(true);
      expect(pubJson.commission_breakdown.referral_direct_split_pct).toBe(40);
      expect(pubJson.commission_breakdown.organic_marketplace_split_pct).toBe(20);
      expect(pubJson.referral_url).toContain("https://app.naelao.com/join?template=");
    });

    it("processes /internal/partner/subscribe-template and /internal/partner/settle-subscription", async () => {
      const fakeDb = await loadTestDb();
      const env = {
        PLATFORM_SECRET,
        PLATFORM_DB: fakeDb,
        QUOTA_CACHE: {} as any,
        BILLING_EVENTS: {} as any,
      };

      // Subscribe template via internal HMAC
      const internalToken = await mintInternalToken(PLATFORM_SECRET, "system");
      const subReq = new Request("http://billing/internal/partner/subscribe-template", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-naelao-tenant-id": "system",
          "x-naelao-internal-token": internalToken,
        },
        body: JSON.stringify({
          spaceId: "space_auto_1",
          templateId: "tpl_miami_1",
          developerUserId: "user_partner_404",
          attributionChannel: "DEVELOPER_REFERRAL",
          monthlySubCents: 15000,
        }),
      });

      const subRes = await billingWorker.fetch(subReq, env as any);
      expect(subRes.status).toBe(200);
      const subJson = await subRes.json<any>();
      expect(subJson.ok).toBe(true);
      expect(subJson.developer_split_pct).toBe(40.0);

      // Trigger settlement
      const settleReq = new Request("http://billing/internal/partner/settle-subscription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-naelao-tenant-id": "system",
          "x-naelao-internal-token": internalToken,
        },
        body: JSON.stringify({
          spaceId: "space_auto_1",
          grossCents: 15000,
          period: "2026-08",
        }),
      });

      const settleRes = await billingWorker.fetch(settleReq, env as any);
      expect(settleRes.status).toBe(200);
      const settleJson = await settleRes.json<any>();
      expect(settleJson.ok).toBe(true);
      expect(settleJson.settlement.developerCutCents).toBe(6000);
      expect(settleJson.settlement.platformCutCents).toBe(9000);
    });

    it("verifies feature gating access rules with verifyFeatureAccess and /billing/partner/verify-access", async () => {
      const fakeDb = await loadTestDb();
      const env = {
        PLATFORM_SECRET,
        PLATFORM_DB: fakeDb,
        QUOTA_CACHE: {} as any,
        BILLING_EVENTS: {} as any,
      };

      // 1. Pure function check
      const gating = {
        monetizationModel: "FREEMIUM_TIERED_SAAS" as const,
        tierAccessRules: {
          entryPlan: {
            allowedProjectKinds: ["static", "basic_lead_form"],
            allowedPlugins: ["basic_analytics"],
            maxExecutionTier: 1,
            monthlyQueryAllowance: 500,
          },
          growthPlan: {
            allowedProjectKinds: ["static", "basic_lead_form", "crm_integration"],
            allowedPlugins: ["basic_analytics", "crm_sync"],
            maxExecutionTier: 2,
            monthlyQueryAllowance: 2000,
          },
          proPlan: {
            allowedProjectKinds: ["*"],
            allowedPlugins: ["*"],
            maxExecutionTier: 3,
            monthlyQueryAllowance: 10000,
          },
        },
      };

      // Entry ($20/mo) allows 'static', rejects 'crm_integration'
      expect(verifyFeatureAccess(20, "static", gating).allowed).toBe(true);
      expect(verifyFeatureAccess(20, "crm_integration", gating).allowed).toBe(false);

      // Growth ($50/mo) allows 'crm_integration', rejects 'advanced_ai_dag'
      expect(verifyFeatureAccess(50, "crm_integration", gating).allowed).toBe(true);
      expect(verifyFeatureAccess(50, "advanced_ai_dag", gating).allowed).toBe(false);

      // Pro ($150/mo) allows everything via wildcard
      expect(verifyFeatureAccess(150, "advanced_ai_dag", gating).allowed).toBe(true);

      // Fixed Buy-out model always allows everything
      expect(verifyFeatureAccess(0, "advanced_ai_dag", { monetizationModel: "FIXED_ONE_OFF_UNLOCKED" }).allowed).toBe(true);

      // 2. HTTP Endpoint check
      await fakeDb.prepare(
        `INSERT INTO partner_accounts (id, user_id, display_name, payout_email, total_earned_cents, balance_cents)
         VALUES ('dev_test', 'user_dev', 'Test Dev', 'test@dev.com', 0, 0)`
      ).run();

      await fakeDb.prepare(
        `INSERT INTO partner_templates (
          id, partner_id, name, category, description, blueprint_r2_key,
          price_cents_monthly, price_cents_one_off, monetization_type,
          monetization_model, tier_access_rules_json, is_public
        ) VALUES ('tpl_gated_1', 'dev_test', 'Gated Suite', 'agency', 'desc', 'key', 9900, 0, 'subscription', 'FREEMIUM_TIERED_SAAS', ?, 1)`
      )
        .bind(JSON.stringify(gating.tierAccessRules))
        .run();

      await fakeDb.prepare(
        `INSERT INTO template_subscriptions (
          id, space_id, template_id, developer_user_id, attribution_channel,
          monthly_sub_cents, developer_split_pct, billing_cycle_count, max_commission_cycles, status
        ) VALUES ('tsub_gated', 'space_client_gated', 'tpl_gated_1', 'user_dev', 'DEVELOPER_REFERRAL', 2000, 40.0, 1, 6, 'active')`
      ).run();

      const verifyReq = new Request(
        "http://billing/billing/partner/verify-access?spaceId=space_client_gated&projectKind=crm_integration&planPriceUsd=20",
        {
          headers: {
            "x-naelao-user-id": "user_client_1",
          },
        }
      );
      const verifyRes = await billingWorker.fetch(verifyReq, env as any);
      expect(verifyRes.status).toBe(200);
      const verifyJson = await verifyRes.json<any>();
      expect(verifyJson.allowed).toBe(false);
      expect(verifyJson.requiredPlan).toContain("$50 Growth Plan");
    });
  });
});
