import type { SpaceBlueprint } from "@naelao/agent-sdk";
import { getDOName } from "@naelao/crypto";
import {
  evaluateBlueprintSecurity,
  sanitizeAndScrubBlueprint,
} from "@naelao/security";
import type { Hono } from "hono";
import type { Env } from "../index.js";

export const GRADUATION_STAGES = [
  "consulting_embed",
  "blueprint_staged",
  "marketplace_published",
] as const;

async function callSpaceDo(
  env: Env,
  tenantId: string,
  doName: string,
  path: string,
  body: unknown
): Promise<Response> {
  const id = env.SPACE_DO.idFromName(
    await getDOName("space", doName, tenantId, env.PLATFORM_SECRET)
  );
  return env.SPACE_DO.get(id).fetch(
    new Request(`http://space-do${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

/** One transaction records the immutable three-stage audit trail and publishes its verified listing. */
export function registerGraduationRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/spaces/:spaceId/graduate", async (c) => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const developerId = c.req.header("x-naelao-user-id") ?? "";
    if (!tenantId || !developerId)
      return c.json(
        { error_code: "unauthorized", message: "Missing developer identity" },
        401
      );
    if (!c.env.SCRIPTS_R2)
      return c.json(
        {
          error_code: "unavailable",
          message: "Blueprint storage not configured",
        },
        503
      );
    const spaceId = c.req.param("spaceId");
    const space = await c.env.PLATFORM_DB.prepare(
      "SELECT id, name, spacetype_id FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
    )
      .bind(spaceId, tenantId)
      .first<{ id: string; name: string; spacetype_id: string }>();
    if (!space)
      return c.json(
        { error_code: "not_found", message: "Space not found" },
        404
      );
    const existing = await c.env.PLATFORM_DB.prepare(
      "SELECT listing_id FROM fde_graduations WHERE space_id = ? AND stage = 'marketplace_published'"
    )
      .bind(spaceId)
      .first<{ listing_id: string }>();
    if (existing)
      return c.json(
        { error_code: "already_graduated", listing_id: existing.listing_id },
        409
      );

    const exported = await callSpaceDo(
      c.env,
      tenantId,
      spaceId,
      "/blueprints/export",
      { space_id: spaceId }
    );
    if (!exported.ok)
      return c.json(
        {
          error_code: "blueprint_export_failed",
          details: await exported.text(),
        },
        422
      );
    const blueprint = sanitizeAndScrubBlueprint(
      await exported.json()
    ) as unknown as SpaceBlueprint;
    const security = evaluateBlueprintSecurity(blueprint);
    if (!security.publishable)
      return c.json({ error_code: "blueprint_rejected", security }, 422);

    const sandboxSpaceId = `graduation-sandbox-${blueprint.id}`;
    const validation = await callSpaceDo(
      c.env,
      tenantId,
      sandboxSpaceId,
      "/blueprints/instantiate",
      { blueprint, target_space_id: sandboxSpaceId }
    );
    if (!validation.ok)
      return c.json(
        {
          error_code: "sandbox_validation_failed",
          details: await validation.text(),
        },
        422
      );
    const dryRun = await validation.json();
    const listingId = crypto.randomUUID();
    await c.env.SCRIPTS_R2.put(
      `blueprints/${blueprint.id}.json`,
      JSON.stringify({ ...blueprint, securityRating: security.rating }),
      {
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          safetyRating: security.rating,
          graduationSpaceId: spaceId,
        },
      }
    );
    await c.env.PLATFORM_DB.batch([
      ...GRADUATION_STAGES.map((stage) =>
        c.env.PLATFORM_DB.prepare(
          "INSERT INTO fde_graduations (id, space_id, developer_id, stage, blueprint_id, listing_id) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(
          crypto.randomUUID(),
          spaceId,
          developerId,
          stage,
          stage === "consulting_embed" ? null : blueprint.id,
          stage === "marketplace_published" ? listingId : null
        )
      ),
      c.env.PLATFORM_DB.prepare(
        `INSERT INTO marketplace_listings
         (id, space_type_id, tenant_id, author_name, name, description, category, pricing, pricing_model, price_cents, plan_gated_features_json, status, blueprint_id, published_at)
         VALUES (?, ?, ?, ?, ?, ?, 'vertical-saas', 'free', 'freemium_tiered', 0, '["growth","pro"]', 'published', ?, datetime('now'))`
      ).bind(
        listingId,
        space.spacetype_id,
        tenantId,
        developerId,
        space.name,
        `Graduated and security-verified blueprint for ${space.name}`,
        blueprint.id
      ),
    ]);
    return c.json(
      {
        space_id: spaceId,
        stage: "marketplace_published",
        blueprint_id: blueprint.id,
        listing_id: listingId,
        security,
        dry_run: dryRun,
      },
      201
    );
  });
}
