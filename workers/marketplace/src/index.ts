import { validateMarketplacePricing, type MarketplacePricingModel } from "@naelao/billing-core";
import { errorResponse, mintInternalToken, requestId } from "@naelao/http";
import { verifyArtifactCertificate, type ConformanceCertificate } from "@naelao/security";
import { Hono } from "hono";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  BILLING_WORKER?: Fetcher;
}
interface Listing {
  id: string; space_type_id: string; tenant_id: string; author_name: string;
  developer_user_id: string | null;
  name: string; description: string; long_description: string | null; category: string;
  tags_json: string; preview_config_json: string | null; pricing: string;
  pricing_model: MarketplacePricingModel; price_cents: number; plan_gated_features_json: string;
  conformance_artifact_json: string | null; conformance_certificate_json: string | null;
  status: string; install_count: number; avg_rating: number; rating_count: number;
  published_at: string | null; created_at: string;
}
function identity(c: { req: { header(name: string): string | undefined } }) {
  return { tenantId: c.req.header("x-naelao-tenant-id") ?? "", userId: c.req.header("x-naelao-user-id") ?? "", role: c.req.header("x-naelao-role") ?? "member" };
}
function parse(raw: string | null, fallback: unknown = null): unknown {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function publicListing(row: Listing) {
  const { conformance_artifact_json: _artifact, conformance_certificate_json: _certificate, tags_json, preview_config_json, plan_gated_features_json, ...listing } = row;
  return { ...listing, tags: parse(tags_json, []), preview_config: parse(preview_config_json), planGatedFeatures: parse(plan_gated_features_json, []) };
}
async function certified(env: Env, id: string, artifact: unknown, receipt: unknown) {
  return !!artifact && typeof artifact === "object" && (artifact as Record<string, unknown>).id === id &&
    await verifyArtifactCertificate(artifact, receipt as ConformanceCertificate | undefined, env.PLATFORM_SECRET, "state-delta");
}
async function certifiedListing(env: Env, row: Listing) {
  const receipt = parse(row.conformance_certificate_json) as ConformanceCertificate | null;
  return receipt?.issuerTenantId === row.tenant_id && certified(env, row.space_type_id, parse(row.conformance_artifact_json), receipt);
}
function positive(raw: string | undefined, fallback: number, max: number) {
  const value = Number(raw); return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}
export const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { if (!c.env.PLATFORM_SECRET) throw new Error("Missing PLATFORM_SECRET"); await next(); });

// D1 is authoritative. Search remains useful without an embedding provider; no fabricated vectors.
app.get("/v1/marketplace", async (c) => {
  const page = positive(c.req.query("page"), 1, 10000);
  const limit = positive(c.req.query("per_page") ?? c.req.query("limit"), 20, 100);
  const offset = c.req.query("offset") === undefined ? (page - 1) * limit : Math.max(0, Number(c.req.query("offset")) || 0);
  const clauses = ["status = 'published'"]; const values: unknown[] = [];
  if (c.req.query("category")) { clauses.push("category = ?"); values.push(c.req.query("category")); }
  if (c.req.query("q")) {
    clauses.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    const pattern = `%${c.req.query("q")!.slice(0, 256).replace(/[\\%_]/g, "\\$&")}%`; values.push(pattern, pattern);
  }
  const where = clauses.join(" AND ");
  const sort = c.req.query("sort") === "rating" ? "avg_rating DESC" : c.req.query("sort") === "newest" ? "published_at DESC" : "install_count DESC";
  const [rows, count] = await Promise.all([
    c.env.PLATFORM_DB.prepare(`SELECT * FROM marketplace_listings WHERE ${where} ORDER BY ${sort}, id LIMIT ? OFFSET ?`).bind(...values, limit, offset).all<Listing>(),
    c.env.PLATFORM_DB.prepare(`SELECT COUNT(*) AS total FROM marketplace_listings WHERE ${where}`).bind(...values).first<{ total: number }>(),
  ]);
  return c.json({ data: rows.results.map(publicListing), meta: { total: count?.total ?? 0, page, per_page: limit } });
});
app.get("/v1/marketplace/:id", async (c) => {
  const row = await c.env.PLATFORM_DB.prepare("SELECT * FROM marketplace_listings WHERE id = ? AND status = 'published'").bind(c.req.param("id")).first<Listing>();
  return row ? c.json(publicListing(row)) : c.json({ error_code: "not_found" }, 404);
});
app.post("/v1/marketplace", async (c) => {
  const { tenantId } = identity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized" }, 401);
  const body = await c.req.json<{
    space_type_id: string; author_name?: string; name: string; description: string; long_description?: string;
    category: string; tags?: string[]; preview_config?: Record<string, unknown>;
    pricing_model?: MarketplacePricingModel; price_cents?: number; planGatedFeatures?: string[];
    conformance_artifact?: Record<string, unknown>; conformance_certificate?: ConformanceCertificate;
  }>();
  if (!body.space_type_id || !body.name || !body.description || !body.category) return c.json({ error_code: "bad_request" }, 400);
  if (!await certified(c.env, body.space_type_id, body.conformance_artifact, body.conformance_certificate) || body.conformance_certificate?.issuerTenantId !== tenantId) return c.json({ error_code: "conformance_certificate_invalid" }, 422);
  const pricing = { pricing_model: body.pricing_model ?? "freemium_tiered", price_cents: body.price_cents ?? 0, planGatedFeatures: body.planGatedFeatures ?? [] };
  const validation = validateMarketplacePricing(pricing);
  if (!validation.valid) return c.json({ error_code: "invalid_marketplace_pricing", errors: validation.errors }, 422);
  const id = crypto.randomUUID();
  await c.env.PLATFORM_DB.prepare(`INSERT INTO marketplace_listings
    (id, space_type_id, tenant_id, developer_user_id, author_name, name, description, long_description, category, tags_json, preview_config_json, pricing, pricing_model, price_cents, plan_gated_features_json, conformance_artifact_json, conformance_certificate_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).bind(
      id, body.space_type_id, tenantId, identity(c).userId || null, body.author_name ?? "", body.name, body.description, body.long_description ?? null,
      body.category, JSON.stringify(body.tags ?? []), body.preview_config ? JSON.stringify(body.preview_config) : null,
      pricing.pricing_model === "fixed_license" ? "paid" : "free", pricing.pricing_model, pricing.price_cents,
      JSON.stringify(pricing.planGatedFeatures), JSON.stringify(body.conformance_artifact), JSON.stringify(body.conformance_certificate),
    ).run();
  return c.json({ id, status: "pending" }, 201);
});
app.patch("/v1/marketplace/:id/review", async (c) => {
  if (identity(c).role !== "platform_admin") return c.json({ error_code: "forbidden" }, 403);
  const body = await c.req.json<{ action: "approve" | "reject"; rejection_reason?: string }>();
  if (body.action !== "approve" && body.action !== "reject") return c.json({ error_code: "bad_request" }, 400);
  const row = await c.env.PLATFORM_DB.prepare("SELECT * FROM marketplace_listings WHERE id = ?").bind(c.req.param("id")).first<Listing>();
  if (!row) return c.json({ error_code: "not_found" }, 404);
  if (body.action === "approve") {
    if (!await certifiedListing(c.env, row)) return c.json({ error_code: "conformance_certificate_invalid" }, 422);
    const validation = validateMarketplacePricing({ pricing_model: row.pricing_model, price_cents: row.price_cents, planGatedFeatures: parse(row.plan_gated_features_json, []) as string[] });
    if (!validation.valid) return c.json({ error_code: "invalid_marketplace_pricing", errors: validation.errors }, 422);
  }
  const status = body.action === "approve" ? "published" : "rejected";
  await c.env.PLATFORM_DB.prepare("UPDATE marketplace_listings SET status = ?, published_at = ?, review_note = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(status, status === "published" ? new Date().toISOString() : null, body.rejection_reason ?? null, row.id).run();
  return c.json({ id: row.id, status });
});
app.post("/v1/marketplace/:id/reviews", async (c) => {
  const { tenantId, userId } = identity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized" }, 401);
  const body = await c.req.json<{ rating: number; body?: string; comment?: string }>();
  if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) return c.json({ error_code: "bad_request" }, 400);
  const listing = await c.env.PLATFORM_DB.prepare("SELECT id FROM marketplace_listings WHERE id = ? AND status = 'published'").bind(c.req.param("id")).first();
  if (!listing) return c.json({ error_code: "not_found" }, 404);
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare(`INSERT INTO marketplace_reviews (id, listing_id, tenant_id, reviewer_name, rating, body, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (listing_id, tenant_id) DO UPDATE SET rating = excluded.rating, body = excluded.body, updated_at = excluded.updated_at`)
      .bind(id, c.req.param("id"), tenantId, userId, body.rating, body.body ?? body.comment ?? null, now, now),
    c.env.PLATFORM_DB.prepare(`UPDATE marketplace_listings SET avg_rating = (SELECT AVG(rating) FROM marketplace_reviews WHERE listing_id = ?),
      rating_count = (SELECT COUNT(*) FROM marketplace_reviews WHERE listing_id = ?), updated_at = ? WHERE id = ?`).bind(c.req.param("id"), c.req.param("id"), now, c.req.param("id")),
  ]);
  return c.json({ id, rating: body.rating, created_at: now }, 201);
});
app.get("/v1/marketplace/:id/reviews", async (c) => {
  const rows = await c.env.PLATFORM_DB.prepare("SELECT id, reviewer_name AS author_name, rating, body, created_at FROM marketplace_reviews WHERE listing_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(c.req.param("id"), positive(c.req.query("limit"), 20, 100)).all();
  return c.json({ data: rows.results });
});
app.post("/v1/marketplace/:id/license-checkout", async c => {
  const { tenantId, userId } = identity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized" }, 401);
  if (!c.env.BILLING_WORKER) return c.json({ error_code: "billing_unavailable" }, 503);
  const listing = await c.env.PLATFORM_DB.prepare("SELECT * FROM marketplace_listings WHERE id = ? AND status = 'published'")
    .bind(c.req.param("id")).first<Listing>();
  if (!listing) return c.json({ error_code: "not_found" }, 404);
  if (listing.price_cents <= 0) return c.json({ error_code: "license_not_required" }, 409);
  if (!await certifiedListing(c.env, listing)) return c.json({ error_code: "conformance_certificate_invalid" }, 422);
  if (listing.developer_user_id === userId) return c.json({ error_code: "self_purchase_not_allowed" }, 409);
  const response = await c.env.BILLING_WORKER.fetch(new Request("http://billing/internal/marketplace/license-checkout", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ listing_id: listing.id, buyer_tenant_id: tenantId }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
});
// Forks keep the certified source immutable. Activation creates tenant-local project state.
app.post("/v1/marketplace/:id/fork", async (c) => {
  const { tenantId } = identity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized" }, 401);
  const row = await c.env.PLATFORM_DB.prepare("SELECT * FROM marketplace_listings WHERE id = ? AND status = 'published'").bind(c.req.param("id")).first<Listing>();
  if (!row) return c.json({ error_code: "not_found" }, 404);
  if (!await certifiedListing(c.env, row)) return c.json({ error_code: "conformance_certificate_invalid" }, 422);
  if (row.price_cents > 0) {
    const purchase = await c.env.PLATFORM_DB.prepare("SELECT id FROM marketplace_license_purchases WHERE tenant_id = ? AND listing_id = ? LIMIT 1")
      .bind(tenantId, row.id).first();
    if (!purchase) return c.json({ error_code: "license_required" }, 402);
  }
  const id = crypto.randomUUID();
  await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO marketplace_forks (id, tenant_id, listing_id, blueprint_id, artifact_json, certificate_json) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, tenantId, row.id, row.space_type_id, row.conformance_artifact_json, row.conformance_certificate_json),
    c.env.PLATFORM_DB.prepare("UPDATE marketplace_listings SET install_count = (SELECT COUNT(*) FROM marketplace_forks WHERE listing_id = ?), updated_at = datetime('now') WHERE id = ?").bind(row.id, row.id),
  ]);
  return c.json({ space_type_id: row.space_type_id, name: row.name, source_listing_id: row.id }, 201);
});
app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
