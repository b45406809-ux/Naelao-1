import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleLemonSqueezyWebhook } from "../../workers/billing/src/lemon-squeezy.js";
import type { LemonSqueezyEnv } from "../../workers/billing/src/lemon-squeezy.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const webhookSecret = "template-royalty-webhook-secret";
const migrations = ["0026_marketplace.sql", "0033_reseller_accounts.sql", "0035_commerce.sql", "0050_webhook_idempotency.sql", "0052_webhook_idempotency_event_type.sql", "0061_reseller_ledger_kind.sql", "0078_template_subscriptions.sql", "0079_fde_graduation.sql", "0086_developer_settlement.sql", "0088_fde_royalty_events.sql", "0089_marketplace_license_sales.sql", "0091_template_royalty_provider_refs.sql"];

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
});
