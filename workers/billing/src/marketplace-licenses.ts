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

/** Platform-owned billing and durable licensing for paid, certified marketplace blueprints. */
export function registerMarketplaceLicenseRoutes(app: Hono<{ Bindings: BillingEnv }>): void {
  app.use("/internal/marketplace/license-checkout", requireInternalHmac(c => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
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
    if (prior.provider_event_id === event.providerEventId) return true;
    // A second provider charge must not create another license or earning. Record a concrete
    // refund task so it is visible to operations instead of retrying the webhook forever.
    await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO marketplace_license_overpayments
      (provider_event_id, purchase_id, tenant_id, listing_id, amount_cents) VALUES (?, ?, ?, ?, ?)`)
      .bind(event.providerEventId, prior.id, tenantId, listing.id, event.amountCents).run();
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
  const purchase = await env.PLATFORM_DB.prepare("SELECT id FROM marketplace_license_purchases WHERE provider_event_id = ? AND tenant_id = ? AND listing_id = ?")
    .bind(event.providerEventId, tenantId, listing.id).first();
  if (!purchase) {
    // Another distinct payment may have won the tenant/listing unique constraint after the
    // initial read. Treat that race like an overpayment, rather than failing the webhook forever.
    const existing = await env.PLATFORM_DB.prepare("SELECT id, provider_event_id FROM marketplace_license_purchases WHERE tenant_id = ? AND listing_id = ?")
      .bind(tenantId, listing.id).first<{ id: string; provider_event_id: string }>();
    if (!existing) throw new Error("marketplace license purchase could not be recorded");
    if (existing.provider_event_id === event.providerEventId) return true;
    await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO marketplace_license_overpayments
      (provider_event_id, purchase_id, tenant_id, listing_id, amount_cents) VALUES (?, ?, ?, ?, ?)`)
      .bind(event.providerEventId, existing.id, tenantId, listing.id, event.amountCents).run();
    return true;
  }
  return true;
}
