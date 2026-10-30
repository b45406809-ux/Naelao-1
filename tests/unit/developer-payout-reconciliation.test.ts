import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileDeveloperPayouts, reserveDeveloperPayout } from "../../workers/billing/src/payout-reconciliation.js";
import { settleTemplateSubscriptionPayment } from "../../workers/billing/src/settlement.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
function harness() {
  const db = createFakeD1(["0026_marketplace.sql", "0078_template_subscriptions.sql", "0079_fde_graduation.sql", "0086_developer_settlement.sql", "0088_fde_royalty_events.sql", "0089_marketplace_license_sales.sql", "0091_template_royalty_provider_refs.sql"].map(name => readFileSync(new URL(`../../infra/migrations/${name}`, import.meta.url), "utf8")));
  db.db.exec("INSERT INTO developer_partner_profiles(user_id,handle,payout_destination,auto_payout_enabled) VALUES ('developer','dev','acct_test',1);");
  db.db.exec("INSERT INTO template_subscriptions(id,space_id,template_id,developer_user_id,attribution_channel) VALUES ('subscription','space','template','developer','DEVELOPER_REFERRAL');");
  const earn = (id: string, amount: number) => db.db.prepare(`INSERT INTO developer_earnings_ledger (id, template_subscription_id, space_id, developer_user_id, attribution_channel, tier, cycle_number, gross_cents, developer_cents, platform_cents) VALUES (?, 'subscription','space','developer','DEVELOPER_REFERRAL','entry',1,?,?,0)`).run(id, amount, amount);
  earn("earning-1", 1000);
  return { db, earn, env: { PLATFORM_DB: db as unknown as D1Database, STRIPE_CONNECT_SECRET_KEY: "stripe-test" } };
}
describe("native developer settlement restart/replay", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("atomically captures earnings once and leaves later earnings for the next payout", async () => {
    const h = harness(); const first = await reserveDeveloperPayout(h.env.PLATFORM_DB, "developer");
    expect(first?.amount_cents).toBe(1000); expect(await reserveDeveloperPayout(h.env.PLATFORM_DB, "developer")).toBeNull();
    h.earn("earning-2", 2000); expect((await reserveDeveloperPayout(h.env.PLATFORM_DB, "developer"))?.amount_cents).toBe(2000);
    h.db.db.close();
  });
  it("reuses the pinned payload and idempotency key after a provider failure", async () => {
    const h = harness(); const keys: string[] = []; let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
      if (url.includes("/accounts/")) return Response.json({ capabilities: { transfers: "active" } });
      keys.push(new Headers(opts.headers).get("Idempotency-Key")!); attempts++;
      if (attempts === 1) throw new Error("Network interrupted after submission");
      const body = opts.body as URLSearchParams;
      expect(body.get("destination")).toBe("acct_test");
      return Response.json({ id: "tr_test", amount: 1000, currency: "usd", destination: "acct_test" });
    }));
    expect(await reconcileDeveloperPayouts(h.env, 1000)).toMatchObject({ deferred: 1, paid: 0 });
    h.db.db.exec("UPDATE developer_partner_profiles SET payout_destination='acct_changed'");
    expect(await reconcileDeveloperPayouts(h.env, 2000, false)).toMatchObject({ paid: 1 });
    expect(keys[0]).toBe(keys[1]);
    expect(await reconcileDeveloperPayouts(h.env, 3000)).toEqual({ queued: 0, paid: 0, deferred: 0 });
    expect(attempts).toBe(2); h.db.db.close();
  });
  it("requires human reconciliation after the idempotency window and never dispatches without credentials", async () => {
    const h = harness(); const outbound = vi.fn(async () => { throw new Error("Unknown transport outcome"); }); vi.stubGlobal("fetch", outbound);
    expect(await reconcileDeveloperPayouts({ PLATFORM_DB: h.env.PLATFORM_DB }, 1000)).toMatchObject({ deferred: 1 });
    expect(outbound).not.toHaveBeenCalled();
    h.db.db.exec("UPDATE developer_payouts SET status='processing',destination_snapshot='acct_test',attempt_started_at=1000");
    await reconcileDeveloperPayouts(h.env, 1000 + 24 * 3600000, false);
    expect(outbound).not.toHaveBeenCalled();
    expect(h.db.db.prepare("SELECT last_error FROM developer_payouts").get()).toMatchObject({ last_error: "manual_provider_reconciliation_required" });
    h.db.db.close();
  });
  it("records captured renewal events once and applies the cumulative 25/20/5 decay", async () => {
    const h = harness();
    for (let cycle = 1; cycle <= 13; cycle++) {
      if (cycle === 1) h.db.db.exec("UPDATE template_subscriptions SET status='paused'");
      const result = await settleTemplateSubscriptionPayment(h.env.PLATFORM_DB, "space", 2000, `ls-payment-${cycle}`, "ls-subscription-1", "subscription");
      expect(result.cycle).toBe(cycle);
      if (cycle === 1) expect(result.developerCents).toBe(500);
      if (cycle === 7) expect(result.developerCents).toBe(400);
      if (cycle === 13) expect(result.developerCents).toBe(100);
    }
    const replay = await settleTemplateSubscriptionPayment(h.env.PLATFORM_DB, "space", 2000, "ls-payment-1", "ls-subscription-1", "subscription");
    expect(replay).toMatchObject({ cycle: 1, developerCents: 500 });
    expect(h.db.db.prepare("SELECT paid_cycles_total FROM template_subscriptions WHERE id='subscription'").get()).toMatchObject({ paid_cycles_total: 13 });
    expect(h.db.db.prepare("SELECT status, provider_subscription_id FROM template_subscriptions WHERE id='subscription'").get()).toMatchObject({ status: "active", provider_subscription_id: "ls-subscription-1" });
    expect(h.db.db.prepare("SELECT COUNT(*) AS n FROM developer_earnings_ledger WHERE provider_event_id IS NOT NULL").get()).toMatchObject({ n: 13 });
    h.db.db.close();
  });
});
