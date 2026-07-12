/**
 * Wallet Connect checkout routing — when a space has an ACTIVE payment connection
 * (migration 0063), a product checkout is created on the BUILDER's OWN payment account
 * instead of Naelao's Lemon Squeezy store. Called from /internal/commerce/checkout; a
 * space with no active connection returns null and the caller continues on the existing
 * Naelao-store path byte-identically.
 *
 * Rails:
 *   stripe        → Checkout Session as a DIRECT CHARGE on the connected Express account
 *                   (StripeProvider constructed with stripeAccount), ad-hoc price_data so
 *                   nothing is pre-provisioned; application_fee_amount = Naelao's fee + any
 *                   parent-builder share (both auto-collected — Naelao then owes the builder
 *                   share via the existing builder_revenue_share ledger at webhook time).
 *   lemon_squeezy → checkout on the builder's OWN LS store via their vault-held API key.
 *                   Their store has no variants for Naelao products, so a product+variant is
 *                   lazily provisioned there ONCE per product (same provision-once pattern as
 *                   Naelao's own publish path) and cached in details_json.product_variants.
 *                   No fee can be auto-split on this rail (LS is merchant-of-record on THEIR
 *                   store) — the platform fee is recorded as a receivable at webhook time,
 *                   and parent-builder share is deliberately not attributed (nothing was
 *                   collected to pay it from).
 *
 * Fail-closed rule: once a connection is ACTIVE, a broken rail (missing platform Stripe key,
 * unreachable vault) throws WalletCheckoutUnavailableError rather than falling back to the
 * Naelao store — falling back would silently settle the builder's revenue into the WRONG
 * custody, the exact thing Wallet Connect exists to prevent.
 */

import { LemonSqueezyProvider, StripeProvider } from "@naelao/billing-core";
import type { BillingEnv } from "./index.js";
import { createLsProductVariant } from "./ls-products.js";
import { getLivePaymentConnection, fetchWalletVaultSecret, type PaymentConnectionRow } from "./wallet-connections.js";

export class WalletCheckoutUnavailableError extends Error {
  constructor(
    public readonly errorCode: string,
    message: string
  ) {
    super(message);
  }
}

export interface WalletCheckoutProduct {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  kind?: "one_time" | "subscription";
}

export interface WalletCheckoutResult {
  checkout_url: string;
  rail: "stripe" | "lemon_squeezy";
  connection_id: string;
}

/**
 * Create a checkout on the space's own connected payment account, or return null when the
 * space has no ACTIVE connection (caller continues on the Naelao-store path unchanged).
 */
export async function routeWalletCheckout(
  env: BillingEnv,
  args: {
    spaceId: string;
    product: WalletCheckoutProduct;
    customerEmail?: string;
    feeBps: number;
    builderFeeBps: number;
  }
): Promise<WalletCheckoutResult | null> {
  const connection = await getLivePaymentConnection(env.PLATFORM_DB, args.spaceId);
  if (!connection || connection.status !== "active" || !connection.provider_account_id) return null;

  const gross = args.product.price_cents;
  const fee = Math.round((gross * args.feeBps) / 10_000);
  // Same clamp recordProductOrder applies: the two fees together never exceed the gross.
  const builderFee = Math.min(Math.round((gross * args.builderFeeBps) / 10_000), Math.max(0, gross - fee));

  if (connection.provider === "stripe") {
    if (!env.STRIPE_PLATFORM_SECRET_KEY) {
      throw new WalletCheckoutUnavailableError(
        "stripe_not_configured",
        "This space's payment account uses Stripe, but Stripe Connect is not configured on this platform"
      );
    }
    const provider = new StripeProvider({
      secretKey: env.STRIPE_PLATFORM_SECRET_KEY,
      stripeAccount: connection.provider_account_id,
    });
    const { url } = await provider.createCheckout({
      spaceId: args.spaceId,
      variantOrPriceId: "", // ad-hoc price_data rail — ignored (see StripeProvider.createCheckout)
      customPriceCents: gross,
      currency: args.product.currency,
      productName: args.product.name,
      ...(args.customerEmail ? { customerEmail: args.customerEmail } : {}),
      applicationFeeCents: fee + builderFee,
      metadata: {
        product_id: args.product.id,
        fee_bps: String(args.feeBps),
        ...(args.builderFeeBps > 0 ? { builder_fee_bps: String(args.builderFeeBps) } : {}),
        payment_connection_id: connection.id,
      },
    });
    return { checkout_url: url, rail: "stripe", connection_id: connection.id };
  }

  // lemon_squeezy rail — the builder's own store.
  if (!connection.credential_name) {
    throw new WalletCheckoutUnavailableError("credentials_missing", "Payment connection has no stored API key — reconnect it");
  }
  const apiKey = await fetchWalletVaultSecret(env, connection.tenant_id, args.spaceId, connection.credential_name);
  if (!apiKey) {
    throw new WalletCheckoutUnavailableError("credentials_unavailable", "Could not resolve this connection's API key — reconnect it");
  }

  const variantId = await resolveWalletLsVariant(env, connection, apiKey, args.product);
  const provider = new LemonSqueezyProvider({
    LEMON_SQUEEZY_API_KEY: apiKey,
    LEMON_SQUEEZY_STORE_ID: connection.provider_account_id,
  });
  const { url } = await provider.createCheckout({
    spaceId: args.spaceId,
    variantOrPriceId: variantId,
    ...(args.customerEmail ? { customerEmail: args.customerEmail } : {}),
    metadata: {
      product_id: args.product.id,
      fee_bps: String(args.feeBps),
      payment_connection_id: connection.id,
      // Deliberately no builder_fee_bps: nothing is auto-collected on this rail to pay a
      // parent-builder share from (see module header).
    },
  });
  return { checkout_url: url, rail: "lemon_squeezy", connection_id: connection.id };
}

/**
 * Resolve (provisioning once if needed) the LS variant for this product on the BUILDER's own
 * store. The productId→variantId map lives in the connection row's details_json — one row per
 * space, so no extra table. A concurrent double-provision is possible but harmless (two
 * variants on their store, one referenced) — LS has no idempotency key for product creation,
 * and this is the same exposure the Naelao-store publish path accepts.
 */
async function resolveWalletLsVariant(
  env: BillingEnv,
  connection: PaymentConnectionRow,
  apiKey: string,
  product: WalletCheckoutProduct
): Promise<string> {
  let details: Record<string, unknown>;
  try {
    details = JSON.parse(connection.details_json) as Record<string, unknown>;
  } catch {
    details = {};
  }
  const variants = (details["product_variants"] ?? {}) as Record<string, string>;
  const cached = variants[product.id];
  if (typeof cached === "string" && cached) return cached;

  const { lsVariantId, lsProductId } = await createLsProductVariant(
    { apiKey, storeId: connection.provider_account_id! },
    {
      name: product.name,
      price_cents: product.price_cents,
      kind: product.kind ?? "one_time",
    }
  );
  variants[product.id] = lsVariantId;
  details["product_variants"] = variants;
  details["product_ls_products"] = { ...((details["product_ls_products"] ?? {}) as Record<string, string>), [product.id]: lsProductId };
  await env.PLATFORM_DB.prepare(
    "UPDATE payment_connections SET details_json = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(JSON.stringify(details), connection.id).run();
  return lsVariantId;
}
