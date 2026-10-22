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
import { mintInternalToken, readBoundedResponseJson, readBoundedResponseText } from "@naelao/http";

async function billing(ctx: PrebuiltOpContext, path: string, body: Record<string, unknown>): Promise<unknown> {
  if (!ctx.env.billingWorker) {
    throw new Error("commerce unavailable: billing worker binding not configured");
  }
  // F20 / A1.16.8: the billing worker's /internal/* routes now require a verified
  // requireInternalHmac token (a static x-naelao-internal header was forgeable) — mint one the
  // same way the spaces() helper below already does.
  const resp = await ctx.env.billingWorker.fetch(
    new Request(`http://billing-worker${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
      },
      body: JSON.stringify({ space_id: ctx.env.spaceId, ...body }),
    })
  );
  if (!resp.ok) throw new Error(`commerce ${path} failed: ${resp.status} ${(await readBoundedResponseText(resp, 8 * 1024).catch(() => "")).slice(0, 300)}`);
  return readBoundedResponseJson(resp, 2 * 1024 * 1024);
}

async function spaces(ctx: PrebuiltOpContext, path: string): Promise<unknown> {
  if (!ctx.env.spacesWorker) throw new Error("commerce unavailable: spaces worker binding not configured");
  const resp = await ctx.env.spacesWorker.fetch(
    new Request(`http://spaces-worker${path}`, {
      headers: {
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
      },
    })
  );
  if (!resp.ok) throw new Error(`commerce read ${path} failed: ${resp.status}`);
  return readBoundedResponseJson(resp, 2 * 1024 * 1024);
}

/**
 * A write against the space's own product catalogue.
 *
 * Separate from `billing()` above: these are the SAME routes the storefront UI already uses to
 * manage products, not a money-in call, so they go to the spaces worker and need no billing
 * binding. The error text deliberately carries the upstream body — an agent that is told only
 * "failed: 400" cannot report anything useful to the owner.
 */
async function spacesWrite(
  ctx: PrebuiltOpContext,
  path: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>
): Promise<unknown> {
  if (!ctx.env.spacesWorker) throw new Error("commerce unavailable: spaces worker binding not configured");
  const resp = await ctx.env.spacesWorker.fetch(
    new Request(`http://spaces-worker${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
      },
      body: JSON.stringify(body),
    })
  );
  if (!resp.ok) throw new Error(`commerce ${method} ${path} failed: ${resp.status} ${(await readBoundedResponseText(resp, 8 * 1024).catch(() => "")).slice(0, 300)}`);
  return readBoundedResponseJson(resp, 2 * 1024 * 1024);
}

export const commerce: PrebuiltScript = {
  name: "commerce",
  description:
    "Sell products through Naelao's Lemon Squeezy store. Create customer checkouts (the only " +
    "money-in path — platform fee applied automatically), list products, and read orders.",
  domain: "api",
  requires_tier: 2,
  paramHints: {
    "commerce.create_product": "name is required. description, price_cents (a whole number of cents, e.g. 2000 for $20), and kind are optional. Creates a DRAFT — it is not for sale until commerce.update_product sets status to 'published'.",
    "commerce.update_product": "product_id is required — the id commerce.create_product or commerce.list_products returned, never guessed. status is the field that actually publishes it (e.g. status: 'published').",
    "commerce.checkout": "product_id is required — from commerce.list_products. customer_email is optional.",
    "commerce.seat_checkout": "user_id is optional when the current run has a signed-in user; otherwise pass the Naelao user id whose seat should be activated. customer_email is optional.",
    "commerce.get_order": "order_id is required — from commerce.list_orders. There is no way to look up an order by anything else.",
  },
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
        ...(typeof a["user_id"] === "string" && a["user_id"] ? { user_id: a["user_id"] } : c.env.userId ? { user_id: c.env.userId } : {}),
        ...(a["customer_email"] ? { customer_email: a["customer_email"] } : {}),
      }),
    "commerce.list_products": (_a, c) => spaces(c, `/spaces/${c.env.spaceId}/products`),
    // Putting something up for sale.
    //
    // This did not exist, and its absence produced the worst failure this platform can have:
    // asked to create a product, the assistant could not, did not say so, and instead reported a
    // detailed success — title, price, "now live on your storefront at shop-…naelao.com". None of
    // it was real; `launchpad_products` was empty. An owner acting on that believes they are
    // selling something they are not. The storefront UI has always had these routes; the agent
    // simply was never given them, so "run a business" stopped at reading.
    "commerce.create_product": (a, c) =>
      spacesWrite(c, `/spaces/${c.env.spaceId}/products`, "POST", {
        name: a["name"],
        ...(a["description"] ? { description: a["description"] } : {}),
        ...(a["price_cents"] !== undefined ? { price_cents: a["price_cents"] } : {}),
        ...(a["kind"] ? { kind: a["kind"] } : {}),
      }),
    // Publishing is deliberately its own step rather than a flag on create: a product going on
    // sale is the moment customers can pay for it, and it should be a decision the agent (or the
    // owner approving it) makes explicitly, not a side effect of drafting.
    "commerce.update_product": (a, c) =>
      spacesWrite(c, `/spaces/${c.env.spaceId}/products/${String(a["product_id"])}`, "PATCH", {
        ...(a["status"] ? { status: a["status"] } : {}),
      }),
    // What actually sold. The seeded daily revenue-review cron asks the assistant to "check
    // business_wallet.balance/history and any storefront/commerce orders" — and there was no
    // operation to list orders at all, only `get_order`, which needs an id you could only have
    // got from a list. So the one recurring job every Launchpad business ships with could not do
    // half of what it was told to do. The route was already there; nothing exposed it.
    "commerce.list_orders": (_a, c) => spaces(c, `/spaces/${c.env.spaceId}/orders`),
    "commerce.get_order": (a, c) => spaces(c, `/spaces/${c.env.spaceId}/orders`).then((o) => {
      const orders = (o as { data?: Array<{ id: string }> }).data ?? [];
      return orders.find((x) => x.id === a["order_id"]) ?? null;
    }),
  },
};
