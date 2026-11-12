import { LemonSqueezyProvider } from "@naelao/billing-core";
import type { NormalizedBillingEvent } from "@naelao/billing-core";
import { requireInternalHmac } from "@naelao/http";
import { verifyArtifactCertificate, type ConformanceCertificate } from "@naelao/security";
import type { Hono } from "hono";
import { createLsProductVariant } from "./ls-products.js";
import type { BillingEnv } from "./index.js";

interface LicenseListing {
  id: string; tenant_id: string; developer_user_id: string | null; name: string; description: string;
  status: string; pricing_model: string; price_cents: number; ls_license_variant_id: string | null;
}
interface LicenseSettlementEnv { PLATFORM_DB: D1Database; PLATFORM_SECRET: string }
interface MarketplaceLicenseRefundCase {
  id: string;
  provider_order_id: string;
  purchase_id: string | null;
  tenant_id: string;
  listing_id: string;
  order_amount_cents: number | null;
  refund_amount_cents: number | null;
  currency: string;
  state: "review_required" | "unmatched_purchase" | "policy_conflict";
  review_reason: string;
  created_at: string;
}

async function attachPendingRefundCases(env: LicenseSettlementEnv, providerOrderId: string, tenantId: string, listingId: string, purchaseId: string): Promise<void> {
  await env.PLATFORM_DB.prepare(`UPDATE marketplace_license_refund_cases
    SET purchase_id = ?, state = CASE
      WHEN currency = 'USD'
        AND (order_amount_cents IS NULL OR order_amount_cents = (SELECT amount_cents FROM marketplace_license_purchases WHERE id = ?))
        AND (refund_amount_cents IS NULL OR refund_amount_cents <= (SELECT amount_cents FROM marketplace_license_purchases WHERE id = ?))
        THEN 'review_required'
      ELSE 'policy_conflict' END,
      review_reason = CASE
        WHEN currency <> 'USD' THEN 'unsupported_currency'
        WHEN order_amount_cents IS NOT NULL AND order_amount_cents <> (SELECT amount_cents FROM marketplace_license_purchases WHERE id = ?) THEN 'order_amount_mismatch'
        WHEN refund_amount_cents > (SELECT amount_cents FROM marketplace_license_purchases WHERE id = ?) THEN 'refund_exceeds_purchase'
        ELSE 'policy_pending' END,
      updated_at = datetime('now')
    WHERE provider_order_id = ? AND tenant_id = ? AND listing_id = ? AND purchase_id IS NULL AND state = 'unmatched_purchase'`)
    .bind(purchaseId, purchaseId, purchaseId, purchaseId, purchaseId, providerOrderId, tenantId, listingId).run();
}

/** Record a signed marketplace refund without choosing license access or author-clawback policy. */
export async function recordMarketplaceLicenseRefundEvent(
  event: NormalizedBillingEvent,
  webhookBodySha256: string,
  env: LicenseSettlementEnv,
): Promise<boolean> {
  if (event.type !== "refund.issued" || event.metadata?.kind !== "marketplace_license") return false;
  const listingId = event.metadata.listing_id;
  const tenantId = event.metadata.buyer_tenant_id;
  if (event.provider !== "lemon_squeezy" || !event.providerEventId ||
      !/^[a-f0-9]{64}$/.test(webhookBodySha256) || !listingId || !tenantId) {
    throw new Error("marketplace license refund metadata is invalid");
  }

  const orderAmount = Number.isSafeInteger(event.amountCents) && event.amountCents > 0 ? event.amountCents : null;
  const refundAmount = event.refundAmountCents === undefined ? null :
    Number.isSafeInteger(event.refundAmountCents) && event.refundAmountCents > 0 ? event.refundAmountCents : null;
  const invalidRefundAmount = event.refundAmountCents !== undefined && refundAmount === null;
  const currency = typeof event.currency === "string" && /^[A-Za-z]{3}$/.test(event.currency)
    ? event.currency.toUpperCase() : "UNKNOWN";
  const purchase = await env.PLATFORM_DB.prepare(`SELECT id, tenant_id, listing_id, amount_cents
    FROM marketplace_license_purchases WHERE provider_event_id = ?`)
    .bind(event.providerEventId)
    .first<{ id: string; tenant_id: string; listing_id: string; amount_cents: number }>();
  const overpayment = await env.PLATFORM_DB.prepare(`SELECT purchase_id, tenant_id, listing_id, amount_cents
    FROM marketplace_license_overpayments WHERE provider_event_id = ?`)
    .bind(event.providerEventId)
    .first<{ purchase_id: string; tenant_id: string; listing_id: string; amount_cents: number }>();
  const matchedPurchase = purchase ?? (overpayment ? await env.PLATFORM_DB.prepare(
    "SELECT id, tenant_id, listing_id, amount_cents FROM marketplace_license_purchases WHERE id = ?",
  ).bind(overpayment.purchase_id).first<{ id: string; tenant_id: string; listing_id: string; amount_cents: number }>() : null);
  const purchaseMatches = !!matchedPurchase && matchedPurchase.tenant_id === tenantId && matchedPurchase.listing_id === listingId &&
    (!overpayment || (overpayment.tenant_id === tenantId && overpayment.listing_id === listingId));
  const amountConflict = (!!matchedPurchase && orderAmount !== null && orderAmount !== matchedPurchase.amount_cents) ||
    (!!overpayment && orderAmount !== null && orderAmount !== overpayment.amount_cents);
  const refundExceedsPurchase = !!matchedPurchase && refundAmount !== null && refundAmount > matchedPurchase.amount_cents;
  const reviewReason: MarketplaceLicenseRefundCase["review_reason"] = event.spaceId !== tenantId ? "tenant_mismatch"
    : ((!!purchase || !!overpayment) && !purchaseMatches) ? "purchase_identity_mismatch"
    : amountConflict ? "order_amount_mismatch"
    : invalidRefundAmount ? "refund_amount_invalid"
    : refundExceedsPurchase ? "refund_exceeds_purchase"
    : currency !== "USD" ? "unsupported_currency"
    : purchaseMatches ? "policy_pending" : "purchase_not_observed";
  const state: MarketplaceLicenseRefundCase["state"] = reviewReason === "purchase_not_observed" ? "unmatched_purchase"
    : reviewReason === "policy_pending" ? "review_required" : "policy_conflict";
  const purchaseId = purchaseMatches ? matchedPurchase!.id : null;

  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO marketplace_license_refund_cases
    (id, provider, provider_order_id, webhook_body_sha256, purchase_id, tenant_id, listing_id,
      order_amount_cents, refund_amount_cents, currency, state, review_reason)
    VALUES (?, 'lemon_squeezy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), event.providerEventId, webhookBodySha256, purchaseId, tenantId, listingId,
      orderAmount, refundAmount, currency, state, reviewReason).run();

  const recorded = await env.PLATFORM_DB.prepare(`SELECT id, provider_order_id, purchase_id, tenant_id, listing_id,
      order_amount_cents, refund_amount_cents, currency, state, review_reason, created_at
    FROM marketplace_license_refund_cases WHERE provider = 'lemon_squeezy' AND webhook_body_sha256 = ?`)
    .bind(webhookBodySha256).first<MarketplaceLicenseRefundCase>();
  if (!recorded) throw new Error("marketplace license refund case could not be recorded");

  if (overpayment && purchaseMatches && recorded.state === "review_required" && refundAmount === overpayment.amount_cents) {
    // An exact full refund of a separately recorded overpayment closes only that refund task.
    // The primary license or author earning is left unchanged until policy is approved.
    await env.PLATFORM_DB.prepare(`UPDATE marketplace_license_overpayments SET status = 'refunded'
      WHERE provider_event_id = ? AND tenant_id = ? AND listing_id = ? AND amount_cents = ? AND status = 'refund_required'`)
      .bind(event.providerEventId, tenantId, listingId, refundAmount).run();
  }
  return true;
}

/** Platform-owned billing and durable licensing for paid, certified marketplace blueprints. */
export function registerMarketplaceLicenseRoutes(app: Hono<{ Bindings: BillingEnv }>): void {
  app.use("/internal/marketplace/license-checkout", requireInternalHmac(c => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
  app.use("/internal/marketplace/license-refund-cases", requireInternalHmac(c => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
  app.get("/internal/marketplace/license-refund-cases", async c => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    if (!tenantId) return c.json({ error_code: "tenant_required" }, 400);
    const state = c.req.query("state");
    if (state && !["review_required", "unmatched_purchase", "policy_conflict"].includes(state)) {
      return c.json({ error_code: "invalid_refund_case_state" }, 400);
    }
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return c.json({ error_code: "invalid_limit" }, 400);
    const rows = await c.env.PLATFORM_DB.prepare(`SELECT id, provider_order_id, purchase_id, tenant_id, listing_id,
        order_amount_cents, refund_amount_cents, currency, state, review_reason, created_at
      FROM marketplace_license_refund_cases
      WHERE tenant_id = ? AND (? IS NULL OR state = ?)
      ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(tenantId, state ?? null, state ?? null, limit)
      .all<MarketplaceLicenseRefundCase>();
    return c.json({ cases: rows.results ?? [], policy: "review_only_no_automatic_license_or_earning_reversal" });
  });
  app.post("/internal/marketplace/license-checkout", async c => {
    const buyerTenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const body = await c.req.json<{ listing_id?: string; buyer_tenant_id?: string }>();
    if (!buyerTenantId || body.buyer_tenant_id !== buyerTenantId || !body.listing_id) return c.json({ error_code: "bad_request" }, 400);
    const listing = await c.env.PLATFORM_DB.prepare("SELECT id, tenant_id, developer_user_id, name, description, status, pricing_model, price_cents, ls_license_variant_id FROM marketplace_listings WHERE id = ?")
      .bind(body.listing_id).first<LicenseListing>();
    if (!listing || listing.status !== "published") return c.json({ error_code: "not_found" }, 404);
    if (listing.pricing_model !== "fixed_license" || listing.price_cents <= 0 || !listing.developer_user_id) return c.json({ error_code: "license_unavailable" }, 409);
    if (listing.tenant_id === buyerTenantId) return c.json({ error_code: "self_purchase_not_allowed" }, 409);
    if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID) return c.json({ error_code: "billing_provider_unavailable" }, 503);
    const existing = await c.env.PLATFORM_DB.prepare("SELECT id FROM marketplace_forks WHERE tenant_id = ? AND listing_id = ?")
      .bind(buyerTenantId, listing.id).first();
    if (existing) return c.json({ error_code: "license_already_acquired" }, 409);

    let variantId = listing.ls_license_variant_id;
    if (!variantId) {
      const token = crypto.randomUUID();
      const claim = await c.env.PLATFORM_DB.prepare(`UPDATE marketplace_listings
        SET ls_license_provisioning_token = ?, ls_license_provisioning_started_at = ?
        WHERE id = ? AND ls_license_variant_id IS NULL
          AND (ls_license_provisioning_token IS NULL OR ls_license_provisioning_started_at < ?)
        RETURNING id`)
        .bind(token, Date.now(), listing.id, Date.now() - 10 * 60_000).first();
      if (claim) {
        try {
          const provisioned = await createLsProductVariant({ apiKey: c.env.LEMON_SQUEEZY_API_KEY, storeId: c.env.LEMON_SQUEEZY_STORE_ID }, {
            name: listing.name.slice(0, 100), description: listing.description.slice(0, 1000), price_cents: listing.price_cents, kind: "one_time",
          });
          await c.env.PLATFORM_DB.prepare(`UPDATE marketplace_listings SET ls_license_product_id = ?, ls_license_variant_id = ?,
            ls_license_provisioning_token = NULL, ls_license_provisioning_started_at = NULL WHERE id = ? AND ls_license_provisioning_token = ?`)
            .bind(provisioned.lsProductId, provisioned.lsVariantId, listing.id, token).run();
          variantId = provisioned.lsVariantId;
        } catch (error) {
          await c.env.PLATFORM_DB.prepare("UPDATE marketplace_listings SET ls_license_provisioning_token = NULL, ls_license_provisioning_started_at = NULL WHERE id = ? AND ls_license_provisioning_token = ?")
            .bind(listing.id, token).run();
          console.error("marketplace license product provisioning failed", (error as Error).message.slice(0, 300));
          return c.json({ error_code: "license_product_unavailable" }, 503);
        }
      } else {
        const current = await c.env.PLATFORM_DB.prepare("SELECT ls_license_variant_id FROM marketplace_listings WHERE id = ?")
          .bind(listing.id).first<{ ls_license_variant_id: string | null }>();
        variantId = current?.ls_license_variant_id ?? null;
      }
    }
    if (!variantId) return c.json({ error_code: "license_product_provisioning" }, 503);
    const provider = new LemonSqueezyProvider({ LEMON_SQUEEZY_API_KEY: c.env.LEMON_SQUEEZY_API_KEY, LEMON_SQUEEZY_STORE_ID: c.env.LEMON_SQUEEZY_STORE_ID });
    const { url } = await provider.createCheckout({
      spaceId: buyerTenantId,
      variantOrPriceId: variantId,
      metadata: { kind: "marketplace_license", listing_id: listing.id, buyer_tenant_id: buyerTenantId },
    });
    return c.json({ checkout_url: url, listing_id: listing.id, price_cents: listing.price_cents, currency: "USD", provider: "lemon_squeezy" });
  });
}

/** Grant a single tenant license and reserve the full fixed-license gross for its author. */
export async function settleMarketplaceLicenseEvent(event: NormalizedBillingEvent, env: LicenseSettlementEnv): Promise<boolean> {
  if (event.type !== "payment.success" || event.metadata?.kind !== "marketplace_license") return false;
  const listingId = event.metadata.listing_id;
  const tenantId = event.metadata.buyer_tenant_id;
  if (!listingId || !tenantId || tenantId !== event.spaceId || !event.providerEventId || !Number.isSafeInteger(event.amountCents) || event.amountCents <= 0 || event.currency?.toUpperCase() !== "USD") {
    throw new Error("marketplace license payment metadata is invalid");
  }
  const listing = await env.PLATFORM_DB.prepare(`SELECT id, tenant_id, developer_user_id, space_type_id, pricing_model, price_cents,
    conformance_artifact_json, conformance_certificate_json FROM marketplace_listings WHERE id = ? AND status = 'published'`)
    .bind(listingId).first<{ id: string; tenant_id: string; developer_user_id: string | null; space_type_id: string; pricing_model: string; price_cents: number; conformance_artifact_json: string | null; conformance_certificate_json: string | null }>();
  if (!listing || listing.pricing_model !== "fixed_license" || listing.price_cents !== event.amountCents || !listing.developer_user_id || listing.tenant_id === tenantId) {
    throw new Error("marketplace license payment does not match a purchasable listing");
  }
  let artifact: Record<string, unknown> | null;
  let certificate: ConformanceCertificate | null;
  try { artifact = JSON.parse(listing.conformance_artifact_json ?? "null"); certificate = JSON.parse(listing.conformance_certificate_json ?? "null"); }
  catch { artifact = null; certificate = null; }
  if (!artifact || artifact.id !== listing.space_type_id || certificate?.issuerTenantId !== listing.tenant_id ||
      !await verifyArtifactCertificate(artifact, certificate, env.PLATFORM_SECRET, "state-delta")) {
    throw new Error("marketplace license listing is missing its certified artifact");
  }
  const prior = await env.PLATFORM_DB.prepare("SELECT id, provider_event_id FROM marketplace_license_purchases WHERE tenant_id = ? AND listing_id = ?")
    .bind(tenantId, listing.id).first<{ id: string; provider_event_id: string }>();
  if (prior) {
    if (prior.provider_event_id === event.providerEventId) {
      await attachPendingRefundCases(env, event.providerEventId, tenantId, listing.id, prior.id);
      return true;
    }
    // A second provider charge must not create another license or earning. Record a concrete
    // refund task so it is visible to operations instead of retrying the webhook forever.
    await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO marketplace_license_overpayments
      (provider_event_id, purchase_id, tenant_id, listing_id, amount_cents) VALUES (?, ?, ?, ?, ?)`)
      .bind(event.providerEventId, prior.id, tenantId, listing.id, event.amountCents).run();
    await attachPendingRefundCases(env, event.providerEventId, tenantId, listing.id, prior.id);
    return true;
  }
  const purchaseId = crypto.randomUUID();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`INSERT INTO marketplace_license_purchases (id, provider_event_id, tenant_id, listing_id, buyer_space_id, amount_cents)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .bind(purchaseId, event.providerEventId, tenantId, listing.id, tenantId, event.amountCents),
    env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO marketplace_forks (id, tenant_id, listing_id, blueprint_id, artifact_json, certificate_json)
      SELECT ?, ?, id, space_type_id, conformance_artifact_json, conformance_certificate_json FROM marketplace_listings
      WHERE id = ? AND EXISTS (SELECT 1 FROM marketplace_license_purchases WHERE provider_event_id = ? AND tenant_id = ? AND listing_id = ?)`)
      .bind(crypto.randomUUID(), tenantId, listing.id, event.providerEventId, tenantId, listing.id),
    env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO developer_license_earnings (id, purchase_id, developer_user_id, amount_cents)
      SELECT ?, p.id, ?, p.amount_cents FROM marketplace_license_purchases p WHERE p.provider_event_id = ? AND p.tenant_id = ? AND p.listing_id = ?`)
      .bind(crypto.randomUUID(), listing.developer_user_id, event.providerEventId, tenantId, listing.id),
  ]);
  const settledPurchase = await env.PLATFORM_DB.prepare("SELECT id FROM marketplace_license_purchases WHERE provider_event_id = ? AND tenant_id = ? AND listing_id = ?")
    .bind(event.providerEventId, tenantId, listing.id).first<{ id: string }>();
  if (!settledPurchase) {
    // Another distinct payment may have won the tenant/listing unique constraint after the
    // initial read. Treat that race like an overpayment, rather than failing the webhook forever.
    const existing = await env.PLATFORM_DB.prepare("SELECT id, provider_event_id FROM marketplace_license_purchases WHERE tenant_id = ? AND listing_id = ?")
      .bind(tenantId, listing.id).first<{ id: string; provider_event_id: string }>();
    if (!existing) throw new Error("marketplace license purchase could not be recorded");
    if (existing.provider_event_id === event.providerEventId) {
      await attachPendingRefundCases(env, event.providerEventId, tenantId, listing.id, existing.id);
      return true;
    }
    await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO marketplace_license_overpayments
      (provider_event_id, purchase_id, tenant_id, listing_id, amount_cents) VALUES (?, ?, ?, ?, ?)`)
      .bind(event.providerEventId, existing.id, tenantId, listing.id, event.amountCents).run();
    await attachPendingRefundCases(env, event.providerEventId, tenantId, listing.id, existing.id);
    return true;
  }
  await attachPendingRefundCases(env, event.providerEventId, tenantId, listing.id, settledPurchase.id);
  return true;
}
