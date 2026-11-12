import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { certifyStateDeltaArtifact } from "../../packages/security/src/marketplace-conformance.js";
import { recordMarketplaceLicenseRefundEvent, registerMarketplaceLicenseRoutes, settleMarketplaceLicenseEvent } from "../../workers/billing/src/marketplace-licenses.js";
import { handleLemonSqueezyWebhook } from "../../workers/billing/src/lemon-squeezy.js";
import { reserveDeveloperPayout } from "../../workers/billing/src/payout-reconciliation.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import type { BillingEnv } from "../../workers/billing/src/index.js";

const LICENSE_MIGRATIONS = ["0026_marketplace.sql", "0078_template_subscriptions.sql", "0079_fde_graduation.sql", "0083_marketplace_conformance_receipts.sql", "0084_marketplace_forks.sql", "0086_developer_settlement.sql", "0088_fde_royalty_events.sql", "0089_marketplace_license_sales.sql", "0090_marketplace_license_overpayments.sql", "0226_marketplace_license_refund_cases.sql"];

async function marketplaceLicenseFixture() {
  const db = createFakeD1(LICENSE_MIGRATIONS.map(name => readFileSync(new URL(`../../infra/migrations/${name}`, import.meta.url), "utf8")));
  db.db.exec(`CREATE TABLE processed_webhook_events (
    provider TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL DEFAULT '',
    processed_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(provider,event_id,event_type))`);
  const secret = "test-marketplace-secret";
  const artifact = { id: "blueprint-1", projects: [] };
  const suite = { fixtures: Array.from({ length: 50 }, (_, i) => ({ id: `f${i}`, input: {}, seed: {}, assertions: [], expectedFiles: {} })) };
  const certificate = await certifyStateDeltaArtifact(artifact, suite, { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "seller");
  db.db.prepare(`INSERT INTO marketplace_listings (id,space_type_id,tenant_id,developer_user_id,author_name,name,description,category,pricing,pricing_model,price_cents,conformance_artifact_json,conformance_certificate_json,status)
    VALUES ('listing','blueprint-1','seller','developer','Developer','Test Blueprint','Description','other','paid','fixed_license',4900,?,?,'published')`)
    .run(JSON.stringify(artifact), JSON.stringify(certificate));
  const env = { PLATFORM_DB: db as unknown as D1Database, PLATFORM_SECRET: secret, LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_test" };
  const paymentEvent = { type: "payment.success", provider: "lemon_squeezy", spaceId: "buyer", customerId: "customer", subscriptionId: null,
    providerEventId: "ls-order-1", variantOrPriceId: "variant", amountCents: 4900, currency: "USD", metadata: { kind: "marketplace_license", listing_id: "listing", buyer_tenant_id: "buyer" } } as const;
  return { db, env, secret, paymentEvent };
}

async function signedWebhook(body: string, secret = "whsec_test"): Promise<Request> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(signature)].map(value => value.toString(16).padStart(2, "0")).join("");
  return new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
    method: "POST", headers: { "X-Signature": hex }, body,
  });
}

describe("paid marketplace license settlement", () => {
  it("grants the certified tenant fork and developer earning once from a captured payment", async () => {
    const { db, env, paymentEvent: event } = await marketplaceLicenseFixture();
    await expect(settleMarketplaceLicenseEvent({ ...event, providerEventId: "ls-order-eur", currency: "EUR" }, env)).rejects.toThrow("metadata is invalid");
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM marketplace_license_purchases").get()).toMatchObject({ n: 0 });
    await expect(settleMarketplaceLicenseEvent(event, env)).resolves.toBe(true);
    await expect(settleMarketplaceLicenseEvent(event, env)).resolves.toBe(true);
    await expect(Promise.all([
      settleMarketplaceLicenseEvent({ ...event, providerEventId: "ls-order-duplicate-1" }, env),
      settleMarketplaceLicenseEvent({ ...event, providerEventId: "ls-order-duplicate-2" }, env),
    ])).resolves.toEqual([true, true]);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM marketplace_license_purchases").get()).toMatchObject({ n: 1 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM marketplace_forks WHERE tenant_id='buyer'").get()).toMatchObject({ n: 1 });
    expect(db.db.prepare("SELECT amount_cents FROM developer_license_earnings").get()).toMatchObject({ amount_cents: 4900 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM marketplace_license_overpayments WHERE status='refund_required'").get()).toMatchObject({ n: 2 });
    const payout = await reserveDeveloperPayout(env.PLATFORM_DB, "developer");
    expect(payout?.amount_cents).toBe(4900);
    db.db.close();
  });

  it("journals signed partial refunds idempotently without revoking a license or reversing earnings", async () => {
    const { db, env, paymentEvent } = await marketplaceLicenseFixture();
    await settleMarketplaceLicenseEvent(paymentEvent, env);
    const metadata = { spaceId: "buyer", kind: "marketplace_license", listing_id: "listing", buyer_tenant_id: "buyer" };
    const body = JSON.stringify({
      meta: { event_name: "order_refunded", custom_data: metadata },
      data: { id: "ls-order-1", attributes: { total: 4900, refunded_amount: 1200, currency: "USD", custom_data: metadata } },
    });
    const first = await handleLemonSqueezyWebhook(await signedWebhook(body), env);
    const duplicate = await handleLemonSqueezyWebhook(await signedWebhook(body), env);
    expect(first.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ duplicate: true, kind: "marketplace_license" });
    expect(db.db.prepare("SELECT state, purchase_id, order_amount_cents, refund_amount_cents FROM marketplace_license_refund_cases").get())
      .toMatchObject({ state: "review_required", purchase_id: expect.any(String), order_amount_cents: 4900, refund_amount_cents: 1200 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM marketplace_forks WHERE tenant_id='buyer'").get()).toMatchObject({ n: 1 });
    expect(db.db.prepare("SELECT amount_cents FROM developer_license_earnings").get()).toMatchObject({ amount_cents: 4900 });
    db.db.close();
  });

  it("reconciles a refund that arrives before the captured payment", async () => {
    const { db, env, paymentEvent } = await marketplaceLicenseFixture();
    const refundEvent = { ...paymentEvent, type: "refund.issued", refundAmountCents: 4900 } as const;
    await recordMarketplaceLicenseRefundEvent(refundEvent, "a".repeat(64), env);
    expect(db.db.prepare("SELECT state, purchase_id FROM marketplace_license_refund_cases").get())
      .toMatchObject({ state: "unmatched_purchase", purchase_id: null });
    await settleMarketplaceLicenseEvent(paymentEvent, env);
    expect(db.db.prepare("SELECT state, purchase_id FROM marketplace_license_refund_cases").get())
      .toMatchObject({ state: "review_required", purchase_id: expect.any(String) });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM marketplace_forks WHERE tenant_id='buyer'").get()).toMatchObject({ n: 1 });
    db.db.close();
  });

  it("closes an exact confirmed duplicate-charge refund task without changing the primary earning", async () => {
    const { db, env, paymentEvent } = await marketplaceLicenseFixture();
    await settleMarketplaceLicenseEvent(paymentEvent, env);
    const duplicatePayment = { ...paymentEvent, providerEventId: "ls-order-overpayment" };
    await settleMarketplaceLicenseEvent(duplicatePayment, env);
    const refundEvent = { ...duplicatePayment, type: "refund.issued", refundAmountCents: 4900 } as const;
    await recordMarketplaceLicenseRefundEvent(refundEvent, "b".repeat(64), env);
    expect(db.db.prepare("SELECT status FROM marketplace_license_overpayments WHERE provider_event_id='ls-order-overpayment'").get())
      .toMatchObject({ status: "refunded" });
    expect(db.db.prepare("SELECT amount_cents FROM developer_license_earnings").get()).toMatchObject({ amount_cents: 4900 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM marketplace_forks WHERE tenant_id='buyer'").get()).toMatchObject({ n: 1 });
    db.db.close();
  });

  it("keeps refund cases visible when the provider omits an explicit refund amount", async () => {
    const { db, env, paymentEvent } = await marketplaceLicenseFixture();
    await settleMarketplaceLicenseEvent(paymentEvent, env);
    const refundEvent = { ...paymentEvent, type: "refund.issued" } as const;
    await recordMarketplaceLicenseRefundEvent(refundEvent, "c".repeat(64), env);
    expect(db.db.prepare("SELECT state, order_amount_cents, refund_amount_cents FROM marketplace_license_refund_cases").get())
      .toMatchObject({ state: "review_required", order_amount_cents: 4900, refund_amount_cents: null });
    db.db.close();
  });

  it("exposes review cases through a tenant-scoped internal read route", async () => {
    const { db, env, paymentEvent } = await marketplaceLicenseFixture();
    await settleMarketplaceLicenseEvent(paymentEvent, env);
    await recordMarketplaceLicenseRefundEvent({ ...paymentEvent, type: "refund.issued" }, "d".repeat(64), env);
    db.db.prepare(`INSERT INTO marketplace_license_refund_cases
      (id,provider,provider_order_id,webhook_body_sha256,tenant_id,listing_id,currency,state,review_reason)
      VALUES ('other-case','lemon_squeezy','other-order',?,'other-tenant','listing','USD','review_required','policy_pending')`)
      .run("e".repeat(64));

    const app = new Hono<{ Bindings: BillingEnv }>();
    app.onError((_error, context) => context.json({ error_code: "forbidden" }, 403));
    registerMarketplaceLicenseRoutes(app);
    const path = "/internal/marketplace/license-refund-cases?state=review_required";
    const denied = await app.request(path, { headers: { "x-naelao-tenant-id": "buyer" } }, env as never);
    expect(denied.status).toBe(403);
    const token = await mintInternalToken(env.PLATFORM_SECRET, "buyer");
    const response = await app.request(path, {
      headers: { "x-naelao-tenant-id": "buyer", "x-naelao-internal-token": token },
    }, env as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      policy: "review_only_no_automatic_license_or_earning_reversal",
      cases: [{ tenant_id: "buyer", state: "review_required" }],
    });
    db.db.close();
  });
});
