/**
 * commerce (spec §11) — the ONLY money-in path. Tier 2.
 *
 * This is a RESERVED prebuilt script (see reserved-capabilities.ts): user/agent-authored
 * scripts can never collect payment. All checkouts go through Naelao's Lemon Squeezy store
 * via the billing worker, which holds the LS credentials (Workers Secret) and applies the
 * platform fee (productConfig.commerce.naelaoFeeBps). That is how Naelao always gets its cut
 * — the builder cannot strip the fee or substitute their own Stripe key.
 *
 * Operations:
 *   commerce.checkout(product_id, customer_email?) → { checkout_url }   (money-in)
 *   commerce.list_products()                       → owner's published products
 *   commerce.get_order(order_id)                   → one order
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

async function billing(ctx: PrebuiltOpContext, path: string, body: Record<string, unknown>): Promise<unknown> {
  if (!ctx.env.billingWorker) {
    throw new Error("commerce unavailable: billing worker binding not configured");
  }
  const resp = await ctx.env.billingWorker.fetch(
    new Request(`http://billing-worker${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-internal": "commerce-script", "x-naelao-tenant-id": ctx.env.tenantId },
      body: JSON.stringify({ space_id: ctx.env.spaceId, ...body }),
    })
  );
  if (!resp.ok) throw new Error(`commerce ${path} failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function spaces(ctx: PrebuiltOpContext, path: string): Promise<unknown> {
  if (!ctx.env.spacesWorker) throw new Error("commerce unavailable: spaces worker binding not configured");
  const resp = await ctx.env.spacesWorker.fetch(
    new Request(`http://spaces-worker${path}`, {
      headers: { "x-naelao-tenant-id": ctx.env.tenantId, "x-naelao-internal": "commerce-script" },
    })
  );
  if (!resp.ok) throw new Error(`commerce read ${path} failed: ${resp.status}`);
  return resp.json();
}

export const commerce: PrebuiltScript = {
  name: "commerce",
  description:
    "Sell products through Naelao's Lemon Squeezy store. Create customer checkouts (the only " +
    "money-in path — platform fee applied automatically), list products, and read orders.",
  domain: "api",
  requires_tier: 2,
  operations: {
    // Money-in: returns a Naelao-store Lemon Squeezy checkout URL for the product.
    "commerce.checkout": (a, c) =>
      billing(c, "/internal/commerce/checkout", {
        product_id: a["product_id"],
        ...(a["customer_email"] ? { customer_email: a["customer_email"] } : {}),
      }),
    // Money-in (seats): a join link for member/seat billing — fee applies, same as products.
    "commerce.seat_checkout": (a, c) =>
      billing(c, "/internal/seats/checkout", {
        ...(a["user_id"] ? { user_id: a["user_id"] } : {}),
        ...(a["customer_email"] ? { customer_email: a["customer_email"] } : {}),
      }),
    "commerce.list_products": (_a, c) => spaces(c, `/spaces/${c.env.spaceId}/products`),
    "commerce.get_order": (a, c) => spaces(c, `/spaces/${c.env.spaceId}/orders`).then((o) => {
      const orders = (o as { data?: Array<{ id: string }> }).data ?? [];
      return orders.find((x) => x.id === a["order_id"]) ?? null;
    }),
  },
};
