import {
  type MarketplacePricingModel,
  validateMarketplacePricing,
} from "@naelao/billing-core";
import type { Hono } from "hono";

interface MarketplaceEnv {
  PLATFORM_DB: D1Database;
}

interface ListingBody {
  space_type_id: string;
  author_name: string;
  name: string;
  description: string;
  category?: string;
  pricing_model: MarketplacePricingModel;
  price_cents: number;
  planGatedFeatures?: string[];
}

export function registerMarketplaceRoutes<T extends MarketplaceEnv>(
  app: Hono<{ Bindings: T }>
): void {
  app.post("/marketplace/listings", async (c) => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    if (!tenantId)
      return c.json(
        { error_code: "unauthorized", message: "Missing tenant" },
        401
      );
    const body = await c.req.json<ListingBody>();
    const validation = validateMarketplacePricing(body);
    if (!validation.valid)
      return c.json(
        {
          error_code: "invalid_marketplace_pricing",
          errors: validation.errors,
        },
        422
      );
    const id = crypto.randomUUID();
    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO marketplace_listings
       (id, space_type_id, tenant_id, author_name, name, description, category, pricing, pricing_model, price_cents, plan_gated_features_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
      .bind(
        id,
        body.space_type_id,
        tenantId,
        body.author_name,
        body.name,
        body.description,
        body.category ?? "other",
        body.pricing_model === "fixed_license" ? "paid" : "free",
        body.pricing_model,
        body.price_cents,
        JSON.stringify(body.planGatedFeatures ?? [])
      )
      .run();
    return c.json({ id, status: "pending", ...validation }, 201);
  });

  app.post("/marketplace/listings/:listingId/publish", async (c) => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    if (!tenantId)
      return c.json(
        { error_code: "unauthorized", message: "Missing tenant" },
        401
      );
    const listing = (await c.env.PLATFORM_DB.prepare(
      "SELECT pricing_model, price_cents, plan_gated_features_json FROM marketplace_listings WHERE id = ? AND tenant_id = ?"
    )
      .bind(c.req.param("listingId"), tenantId)
      .first()) as {
      pricing_model: MarketplacePricingModel;
      price_cents: number;
      plan_gated_features_json: string;
    } | null;
    if (!listing)
      return c.json(
        { error_code: "not_found", message: "Listing not found" },
        404
      );
    let gates: string[] = [];
    try {
      gates = JSON.parse(listing.plan_gated_features_json) as string[];
    } catch {
      return c.json(
        {
          error_code: "invalid_listing",
          message: "Feature gates are malformed",
        },
        422
      );
    }
    const validation = validateMarketplacePricing({
      pricing_model: listing.pricing_model,
      price_cents: listing.price_cents,
      planGatedFeatures: gates,
    });
    if (!validation.valid)
      return c.json(
        {
          error_code: "invalid_marketplace_pricing",
          errors: validation.errors,
        },
        422
      );
    await c.env.PLATFORM_DB.prepare(
      "UPDATE marketplace_listings SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    )
      .bind(c.req.param("listingId"))
      .run();
    return c.json({ id: c.req.param("listingId"), status: "published" });
  });
}
