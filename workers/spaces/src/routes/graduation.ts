import type { SpaceBlueprint } from "@naelao/agent-sdk";
import { evaluateBlueprintSecurity, verifyArtifactCertificate, type ConformanceCertificate } from "@naelao/security";
import type { Hono } from "hono";
import type { Env } from "../index.js";
import { resolveEndUserSpaceRole } from "../space-auth.js";
import { certifiedBlueprintKey } from "../certified-blueprint.js";

export const GRADUATION_STAGES = ["consulting_embed", "blueprint_staged", "marketplace_published"] as const;

/** Graduation publishes the already-tested immutable artifact, never a fresh untested export. */
export function registerGraduationRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/spaces/:spaceId/graduate", async c => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const developerId = c.req.header("x-naelao-user-id") ?? "";
    if (!tenantId || !developerId) return c.json({ error_code: "unauthorized" }, 401);
    if (!c.env.SCRIPTS_R2) return c.json({ error_code: "unavailable" }, 503);
    const spaceId = c.req.param("spaceId");
    const role = c.req.header("x-naelao-role");
    const membership = role === "product_end_user" ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, developerId) : role;
    if (membership !== "owner" && membership !== "admin") return c.json({ error_code: "owner_or_admin_required" }, 403);
    const space = await c.env.PLATFORM_DB.prepare("SELECT id, name FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'").bind(spaceId, tenantId).first<{ id: string; name: string }>();
    if (!space) return c.json({ error_code: "not_found" }, 404);
    const body = await c.req.json<{ conformance_job_id?: string; name?: string; description?: string }>().catch(() => ({} as { conformance_job_id?: string; name?: string; description?: string }));
    if (!body.conformance_job_id) return c.json({ error_code: "conformance_job_required", message: "Complete a blueprint export conformance job first" }, 422);
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 160)) return c.json({ error_code: "invalid_listing_name" }, 400);
    if (body.description !== undefined && (typeof body.description !== "string" || !body.description.trim() || body.description.trim().length > 2000)) return c.json({ error_code: "invalid_listing_description" }, 400);
    const job = await c.env.PLATFORM_DB.prepare("SELECT artifact_key FROM blueprint_export_jobs WHERE id = ? AND tenant_id = ? AND space_id = ?").bind(body.conformance_job_id, tenantId, spaceId).first<{ artifact_key: string }>();
    if (!job) return c.json({ error_code: "conformance_job_not_found" }, 404);
    const original = await c.env.SCRIPTS_R2.get(job.artifact_key);
    if (!original) return c.json({ error_code: "conformance_artifact_missing" }, 422);
    const { blueprint: source } = await original.json<{ blueprint: SpaceBlueprint }>();
    const existingListing = await c.env.PLATFORM_DB.prepare("SELECT id FROM marketplace_listings WHERE tenant_id=? AND blueprint_id=? AND status='published' LIMIT 1").bind(tenantId, source.id).first<{ id: string }>();
    if (existingListing) return c.json({ error_code: "already_graduated", listing_id: existingListing.id, blueprint_id: source.id }, 409);
    const stored = await c.env.SCRIPTS_R2.get(certifiedBlueprintKey(tenantId, source.id))
      ?? await c.env.SCRIPTS_R2.get(`blueprints/${source.id}.json`);
    if (!stored) return c.json({ error_code: "conformance_not_certified" }, 422);
    const envelope = await stored.json<{ blueprint: SpaceBlueprint & { securityRating?: string }; conformanceCertificate: ConformanceCertificate }>();
    const blueprint = { ...envelope.blueprint }; delete blueprint.securityRating;
    if (envelope.conformanceCertificate?.issuerTenantId !== tenantId || !await verifyArtifactCertificate(blueprint, envelope.conformanceCertificate, c.env.PLATFORM_SECRET, "state-delta") || !await verifyArtifactCertificate(source, envelope.conformanceCertificate, c.env.PLATFORM_SECRET, "state-delta")) return c.json({ error_code: "conformance_certificate_invalid" }, 422);
    const security = evaluateBlueprintSecurity(blueprint);
    if (!security.publishable) return c.json({ error_code: "blueprint_rejected", security }, 422);
    const listingId = crypto.randomUUID();
    const developerDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(developerId)));
    const developerHandle = `fde-${[...developerDigest].slice(0, 20).map(value => value.toString(16).padStart(2, "0")).join("")}`;
    const hasSpaceGraduation = await c.env.PLATFORM_DB.prepare("SELECT 1 AS present FROM fde_graduations WHERE space_id=? AND stage='marketplace_published'").bind(spaceId).first();
    const listingName = body.name?.trim() || String(blueprint.metadata.name ?? space.name).slice(0, 160);
    const listingDescription = body.description?.trim() || String(blueprint.metadata.description ?? `Certified blueprint for ${listingName}`).slice(0, 2000);
    await c.env.PLATFORM_DB.batch([
      ...(!hasSpaceGraduation ? GRADUATION_STAGES.map(stage => c.env.PLATFORM_DB.prepare("INSERT INTO fde_graduations (id, space_id, developer_id, stage, blueprint_id, listing_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), spaceId, developerId, stage, stage === "consulting_embed" ? null : blueprint.id, stage === "marketplace_published" ? listingId : null)) : []),
      c.env.PLATFORM_DB.prepare(`INSERT INTO marketplace_listings
        (id, space_type_id, tenant_id, developer_user_id, author_name, name, description, category, pricing, pricing_model, price_cents, plan_gated_features_json, status, blueprint_id, published_at, conformance_artifact_json, conformance_certificate_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'vertical-saas', 'free', 'freemium_tiered', 0, '["growth","pro"]', 'published', ?, datetime('now'), ?, ?)`)
        .bind(listingId, blueprint.id, tenantId, developerId, developerId, listingName, listingDescription, blueprint.id, JSON.stringify(blueprint), JSON.stringify(envelope.conformanceCertificate)),
      // Certification is the cohort entry point. D1 serializes this batch so at most fifty
      // successfully graduated developers receive a pioneer rank.
      c.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO developer_partner_profiles (user_id, handle, status) VALUES (?, ?, 'active')")
        .bind(developerId, developerHandle),
      c.env.PLATFORM_DB.prepare(`UPDATE developer_partner_profiles
        SET pioneer_rank = (SELECT COALESCE(MAX(pioneer_rank), 0) + 1 FROM developer_partner_profiles WHERE pioneer_rank IS NOT NULL)
        WHERE user_id = ? AND pioneer_rank IS NULL
          AND (SELECT COUNT(*) FROM developer_partner_profiles WHERE pioneer_rank IS NOT NULL) < 50`)
        .bind(developerId),
    ]);
    return c.json({ space_id: spaceId, stage: "marketplace_published", blueprint_id: blueprint.id, listing_id: listingId, security }, 201);
  });
}
