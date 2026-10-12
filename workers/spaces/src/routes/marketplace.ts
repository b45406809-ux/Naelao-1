import {
  type MarketplacePricingModel,
  validateMarketplacePricing,
} from "@naelao/billing-core";
import { verifyArtifactCertificate, type ConformanceCertificate } from "@naelao/security";
import type { Hono } from "hono";

interface MarketplaceEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
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
  conformance_artifact?: Record<string, unknown>;
  conformance_certificate?: ConformanceCertificate;
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
    if (!body.conformance_artifact || body.conformance_artifact.id !== body.space_type_id ||
        !await verifyArtifactCertificate(body.conformance_artifact, body.conformance_certificate, c.env.PLATFORM_SECRET, "state-delta") || body.conformance_certificate?.issuerTenantId !== tenantId) {
      return c.json({ error_code: "conformance_certificate_invalid", message: "A passing artifact-bound certificate is required" }, 422);
    }
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
       (id, space_type_id, tenant_id, developer_user_id, author_name, name, description, category, pricing, pricing_model, price_cents, plan_gated_features_json, conformance_artifact_json, conformance_certificate_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
      .bind(
        id,
        body.space_type_id,
        tenantId,
        c.req.header("x-naelao-user-id") ?? null,
        body.author_name,
        body.name,
        body.description,
        body.category ?? "other",
        body.pricing_model === "fixed_license" ? "paid" : "free",
        body.pricing_model,
        body.price_cents,
        JSON.stringify(body.planGatedFeatures ?? []),
        JSON.stringify(body.conformance_artifact),
        JSON.stringify(body.conformance_certificate)
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
      "SELECT space_type_id, pricing_model, price_cents, plan_gated_features_json, conformance_artifact_json, conformance_certificate_json FROM marketplace_listings WHERE id = ? AND tenant_id = ?"
    )
      .bind(c.req.param("listingId"), tenantId)
      .first()) as {
      space_type_id: string;
      pricing_model: MarketplacePricingModel;
      price_cents: number;
      plan_gated_features_json: string;
      conformance_artifact_json: string | null;
      conformance_certificate_json: string | null;
    } | null;
    if (!listing)
      return c.json(
        { error_code: "not_found", message: "Listing not found" },
        404
      );
    let artifact: Record<string, unknown>;
    let certificate: ConformanceCertificate;
    try {
      artifact = JSON.parse(listing.conformance_artifact_json ?? "null") as Record<string, unknown>;
      certificate = JSON.parse(listing.conformance_certificate_json ?? "null") as ConformanceCertificate;
    } catch {
      return c.json({ error_code: "conformance_certificate_invalid" }, 422);
    }
    if (!artifact || artifact.id !== listing.space_type_id ||
        !await verifyArtifactCertificate(artifact, certificate, c.env.PLATFORM_SECRET, "state-delta") || certificate.issuerTenantId !== tenantId) {
      return c.json({ error_code: "conformance_certificate_invalid" }, 422);
    }
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
