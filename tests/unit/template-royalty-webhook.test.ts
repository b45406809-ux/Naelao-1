import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleLemonSqueezyWebhook } from "../../workers/billing/src/lemon-squeezy.js";
import type { LemonSqueezyEnv } from "../../workers/billing/src/lemon-squeezy.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const webhookSecret = "template-royalty-webhook-secret";
const migrations = ["0003_spaces.sql", "0021_space_members.sql", "0026_marketplace.sql", "0033_reseller_accounts.sql", "0035_commerce.sql", "0050_webhook_idempotency.sql", "0052_webhook_idempotency_event_type.sql", "0061_reseller_ledger_kind.sql", "0078_template_subscriptions.sql", "0079_fde_graduation.sql", "0086_developer_settlement.sql", "0088_fde_royalty_events.sql", "0089_marketplace_license_sales.sql", "0091_template_royalty_provider_refs.sql", "0092_marketplace_template_subscriptions.sql", "0251_marketplace_template_subscription_refunds.sql"];

async function signedRequest(body: string): Promise<Request> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const signature = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
  return new Request("https://billing.naelao.com/webhooks/lemon-squeezy", { method: "POST", headers: { "X-Signature": signature }, body });
}

function capturedRenewal(orderId: string) {
  return JSON.stringify({ meta: { event_name: "subscription_payment_success", custom_data: { spaceId: "space-1", kind: "template_subscription", template_subscription_id: "template-sub-1" } },
    data: { id: "subscription-resource", attributes: { subscription_id: "ls-sub-1", order_id: orderId, total: 2000, currency: "USD", customer_id: "customer-1" } } });
}

function capturedSubscriptionRefund(input: { invoiceId?: string; dataId?: string; amount?: string | number; spaceId?: string; subscriptionId?: string; templateSubscriptionId?: string } = {}) {
  const attributes: Record<string, unknown> = { subscription_id: input.subscriptionId ?? "ls-sub-1", order_id: input.invoiceId ?? "ls-invoice-1", total: 2000, currency: "USD" };
  if (input.amount !== undefined) attributes.refunded_amount = input.amount;
  return JSON.stringify({ meta: { event_name: "subscription_payment_refunded", custom_data: {
    spaceId: input.spaceId ?? "space-1", kind: "template_subscription", template_subscription_id: input.templateSubscriptionId ?? "template-sub-1",
  } }, data: { id: input.dataId ?? "invoice-resource", attributes } });
}

describe("captured native template renewal webhook", () => {
  it("activates only after captured payment, deduplicates event replay, and advances on the next order", async () => {
    const db = createFakeD1(migrations.map(name => readFileSync(new URL(`../../infra/migrations/${name}`, import.meta.url), "utf8")));
    db.db.prepare("INSERT INTO developer_partner_profiles(user_id,handle,pioneer_rank) VALUES ('developer','fde-developer',1)").run();
    db.db.prepare(`INSERT INTO template_subscriptions (id,space_id,template_id,developer_user_id,attribution_channel,status,pioneer_eligible)
      VALUES ('template-sub-1','space-1','template-1','developer','MARKETPLACE_ORGANIC','paused',1)`).run();
    const env = { LEMON_SQUEEZY_WEBHOOK_SECRET: webhookSecret, PLATFORM_SECRET: "platform-secret", PLATFORM_DB: db as unknown as D1Database } as LemonSqueezyEnv;
    const first = capturedRenewal("ls-order-1");
    const response = await handleLemonSqueezyWebhook(await signedRequest(first), env);
    expect(response.status).toBe(200);
    expect(await (await handleLemonSqueezyWebhook(await signedRequest(first), env)).json()).toMatchObject({ duplicate: true });
    const second = capturedRenewal("ls-order-2");
    expect((await handleLemonSqueezyWebhook(await signedRequest(second), env)).status).toBe(200);
    expect(db.db.prepare("SELECT status, provider_subscription_id, paid_cycles_total FROM template_subscriptions WHERE id='template-sub-1'").get())
      .toMatchObject({ status: "active", provider_subscription_id: "ls-sub-1", paid_cycles_total: 2 });
    expect(db.db.prepare("SELECT COUNT(*) AS n, SUM(developer_cents) AS cents FROM developer_earnings_ledger WHERE template_subscription_id='template-sub-1'").get())
      .toMatchObject({ n: 2, cents: 1600 });
    db.db.close();
  });

  it("records signed subscription refund evidence once without changing access or royalty ledgers", async () => {
    const db = createFakeD1(migrations.map(name => readFileSync(new URL(`../../infra/migrations/${name}`, import.meta.url), "utf8")));
    db.db.prepare("INSERT INTO marketplace_listings (id,space_type_id,tenant_id,author_name,name,description) VALUES ('listing-1','type-1','author-tenant','Author','Template','Description')").run();
    db.db.prepare("INSERT INTO spaces (id,tenant_id,spacetype_id,name) VALUES ('space-1','buyer-tenant','type-1','Buyer space')").run();
    db.db.prepare(`INSERT INTO template_subscriptions (id,space_id,template_id,marketplace_listing_id,developer_user_id,attribution_channel,status,pioneer_eligible,paid_cycles_total,provider_subscription_id)
      VALUES ('template-sub-1','space-1','template-1','listing-1','developer','MARKETPLACE_ORGANIC','active',0,3,'ls-sub-1')`).run();
    const env = { LEMON_SQUEEZY_WEBHOOK_SECRET: webhookSecret, PLATFORM_SECRET: "platform-secret", PLATFORM_DB: db as unknown as D1Database } as LemonSqueezyEnv;
    const first = capturedSubscriptionRefund({ invoiceId: "ls-invoice-1", amount: "700" });
    const response = await handleLemonSqueezyWebhook(await signedRequest(first), env);
    expect(response.status).toBe(200);
    expect(await (await handleLemonSqueezyWebhook(await signedRequest(first), env)).json()).toMatchObject({ duplicate: true });
    const second = capturedSubscriptionRefund({ invoiceId: "ls-invoice-1", amount: "900" });
    expect((await handleLemonSqueezyWebhook(await signedRequest(second), env)).status).toBe(200);
    expect((await handleLemonSqueezyWebhook(await signedRequest(capturedSubscriptionRefund({ invoiceId: "ls-invoice-2" })), env)).status).toBe(200);
    expect((await handleLemonSqueezyWebhook(await signedRequest(capturedSubscriptionRefund({ invoiceId: "", dataId: "" })), env)).status).toBe(200);
    expect(db.db.prepare("SELECT provider_invoice_id,refund_amount_cents,state,review_reason FROM marketplace_template_subscription_refund_cases").all())
      .toEqual(expect.arrayContaining([
        { provider_invoice_id: "ls-invoice-1", refund_amount_cents: 700, state: "review_required", review_reason: "policy_pending" },
        { provider_invoice_id: "ls-invoice-1", refund_amount_cents: 900, state: "review_required", review_reason: "policy_pending" },
        { provider_invoice_id: "ls-invoice-2", refund_amount_cents: null, state: "review_required", review_reason: "refund_amount_unknown" },
        { provider_invoice_id: null, refund_amount_cents: null, state: "review_required", review_reason: "invoice_identity_missing" },
      ]));
    expect(db.db.prepare("SELECT provider_event_id FROM marketplace_template_subscription_refund_cases WHERE provider_invoice_id IS NULL").get()?.provider_event_id)
      .toMatch(/^body:[a-f0-9]{64}$/);
    expect(db.db.prepare("SELECT status,paid_cycles_total FROM template_subscriptions WHERE id='template-sub-1'").get())
      .toMatchObject({ status: "active", paid_cycles_total: 3 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM developer_earnings_ledger WHERE template_subscription_id='template-sub-1'").get())
      .toMatchObject({ n: 0 });
    db.db.close();
  });

  it("retains unmatched and cross-Space refund events for review without linking another subscription", async () => {
    const db = createFakeD1(migrations.map(name => readFileSync(new URL(`../../infra/migrations/${name}`, import.meta.url), "utf8")));
    db.db.prepare("INSERT INTO marketplace_listings (id,space_type_id,tenant_id,author_name,name,description) VALUES ('listing-1','type-1','author-tenant','Author','Template','Description')").run();
    db.db.prepare("INSERT INTO spaces (id,tenant_id,spacetype_id,name) VALUES ('space-1','buyer-tenant','type-1','Buyer space')").run();
    db.db.prepare(`INSERT INTO template_subscriptions (id,space_id,template_id,marketplace_listing_id,developer_user_id,attribution_channel,status,pioneer_eligible,provider_subscription_id)
      VALUES ('template-sub-1','space-1','template-1','listing-1','developer','MARKETPLACE_ORGANIC','active',0,'ls-sub-1')`).run();
    const env = { LEMON_SQUEEZY_WEBHOOK_SECRET: webhookSecret, PLATFORM_SECRET: "platform-secret", PLATFORM_DB: db as unknown as D1Database } as LemonSqueezyEnv;
    expect((await handleLemonSqueezyWebhook(await signedRequest(capturedSubscriptionRefund({ templateSubscriptionId: "unknown-sub", subscriptionId: "ls-sub-unknown" })), env)).status).toBe(200);
    expect((await handleLemonSqueezyWebhook(await signedRequest(capturedSubscriptionRefund({ spaceId: "space-other" })), env)).status).toBe(200);
    const cases = db.db.prepare("SELECT template_subscription_id,state,review_reason FROM marketplace_template_subscription_refund_cases ORDER BY created_at,id").all();
    expect(cases).toContainEqual(expect.objectContaining({ template_subscription_id: null, state: "unmatched_subscription", review_reason: "subscription_not_observed" }));
    expect(cases).toContainEqual(expect.objectContaining({ template_subscription_id: null, state: "policy_conflict", review_reason: "space_mismatch" }));
    expect(db.db.prepare("SELECT paid_cycles_total,status FROM template_subscriptions WHERE id='template-sub-1'").get())
      .toMatchObject({ paid_cycles_total: 0, status: "active" });
    db.db.close();
  });
});
