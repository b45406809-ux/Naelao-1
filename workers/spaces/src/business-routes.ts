// Three-Tier Platform Model, Phase C (docs/spec-appendix/A1-script-agents-and-space-assistants.md
// §A1.17) — businesses, the space switcher, and invites.
//
// registerBusinessRoutes(app) is called once from index.ts, same convention as
// registerBuilderRoutes/registerProductEndUserRoutes: a self-contained module with its own
// minimal structural Env (avoids a circular import with index.ts).

import type { Hono } from "hono";
import { getDOName } from "@naelao/crypto";
import { createBusinessForEndUser, resolvePersonalPlanTier, loadEffectiveProductConfig, type BusinessCreateEnv } from "./business-create.js";
import { canPersonalPlanInvite } from "@naelao/billing-core";
import { resolveEndUserBusinessRole } from "./business-auth.js";

export interface BusinessRoutesEnv extends BusinessCreateEnv {
  SPACE_DO: DurableObjectNamespace;
  /** F-15: best-effort invite emails (same binding the product-end-user routes use). */
  NOTIFICATIONS_WORKER?: Fetcher;
  /** F-15: base URL for building a clickable accept link in the invite email. */
  PRODUCT_SHELL_URL?: string;
}

/**
 * F-15: email the invitee a best-effort invite with the accept link. Previously the invite route
 * stored the email + hashed token but sent nothing — "invite by email" collected an address it
 * never used, working only by manual link paste. Never blocks the caller's own response (a
 * notifications outage must not fail the invite creation), matching the product-end-user email
 * helper's posture exactly.
 */
async function sendInviteEmail(
  env: BusinessRoutesEnv, tenantId: string, spaceId: string, to: string,
  businessSpaceId: string, token: string, slug: string | null
): Promise<void> {
  if (!env.NOTIFICATIONS_WORKER) return;
  const link = env.PRODUCT_SHELL_URL && slug
    ? `${env.PRODUCT_SHELL_URL}/p/${slug}/invites/${businessSpaceId}/accept?token=${token}`
    : null;
  const body = link
    ? `You've been invited to join a business on Naelao. Sign in and open this link to accept:\n\n${link}`
    : `You've been invited to join a business on Naelao. Ask the person who invited you for the accept link, or use this invite token after signing in: ${token}`;
  try {
    await env.NOTIFICATIONS_WORKER.fetch(new Request("http://notifications-worker/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId },
      body: JSON.stringify({ channel: "email", space_id: spaceId, to, subject: "You've been invited to a business on Naelao", body }),
    }));
  } catch { /* best-effort — never blocks the caller's own response */ }
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A cryptographically random, URL-safe invite token — high entropy, so a fast digest (not
 *  PBKDF2) is the correct hash for its index, same reasoning as builder_api_key_index. */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return "inv_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function callerIdentity(c: { req: { header(h: string): string | undefined } }): { tenantId: string; userId: string; role: string } {
  return {
    tenantId: c.req.header("x-naelao-tenant-id") ?? "",
    userId: c.req.header("x-naelao-user-id") ?? "",
    role: c.req.header("x-naelao-role") ?? "",
  };
}

async function seedSpaceDoMember(env: BusinessRoutesEnv, spaceId: string, tenantId: string, userId: string, role: string): Promise<void> {
  try {
    const doId = env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, env.PLATFORM_SECRET));
    const stub = env.SPACE_DO.get(doId);
    await stub.fetch(new Request("http://space-do/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space_id: spaceId, user_id: userId, role }),
    }));
  } catch {
    // Best-effort — business_memberships (the D1 index) is the source of truth for the shell's
    // switcher/gating; a failed SpaceDO mirror is recoverable (same non-fatal precedent as
    // seedOwnerMember in the provisioner).
  }
}

export function registerBusinessRoutes(app: Hono<any>): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  // POST /spaces/:productSpaceId/businesses — product-scoped wrapper over createBusinessForEndUser
  // (the same logic POST /reseller/spaces uses). Being product-scoped (a path spaceId) is what
  // lets the router's product_end_user allowlist capture it safely — the bare /reseller/spaces
  // route has no path spaceId to key a membership check off of. Dual-writes business_memberships
  // for the owner (Phase B's flat "member" floor becomes a real role once this row exists) and
  // best-effort mirrors into the business's own SpaceDO space_members (matches seedOwnerMember's
  // precedent — the provisioner does this too once the space finishes provisioning, so this call
  // is a head start, not a replacement).
  app.post("/spaces/:productSpaceId/businesses", async (c) => {
    const env = c.env as BusinessRoutesEnv;
    const productSpaceId = c.req.param("productSpaceId");
    const { userId } = callerIdentity(c);
    if (!userId) return c.json({ error_code: "unauthorized", message: "Missing user" }, 401);

    const body = await c.req.json<{
      name: string;
      spacetype_id: string;
      template_id?: string;
      template_ids?: string[];
      config_overrides?: Record<string, unknown>;
    }>().catch(() => null);
    if (!body?.name || !body.spacetype_id) {
      return c.json({ error_code: "bad_request", message: "name and spacetype_id are required" }, 400);
    }

    const result = await createBusinessForEndUser(env, {
      resellerProductSpaceId: productSpaceId,
      userId,
      name: body.name,
      spacetypeId: body.spacetype_id,
      ...(body.template_ids ? { templateIds: body.template_ids } : {}),
      ...(body.template_id ? { templateId: body.template_id } : {}),
      ...(body.config_overrides ? { configOverrides: body.config_overrides } : {}),
    });
    if (!result.ok) {
      return c.json({ error_code: result.error_code, message: result.message }, result.status);
    }

    await env.PLATFORM_DB.prepare(
      `INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status, joined_at)
       VALUES (?, ?, ?, 'owner', 'active', datetime('now'))
       ON CONFLICT(business_space_id, end_user_id) DO NOTHING`
    ).bind(result.spaceId, productSpaceId, userId).run();
    await seedSpaceDoMember(env, result.spaceId, result.tenantId, userId, "owner");

    return c.json(
      { tenant_id: result.tenantId, space_id: result.spaceId, status: result.status, parent_tenant_id: result.parentTenantId },
      201
    );
  });

  // GET /spaces/:productSpaceId/my-businesses — the space switcher's list: every business (under
  // this product) the calling end user belongs to, from the business_memberships index (never
  // opens each business's own SpaceDO — that's exactly what this index exists to avoid at scale).
  app.get("/spaces/:productSpaceId/my-businesses", async (c) => {
    const env = c.env as BusinessRoutesEnv;
    const productSpaceId = c.req.param("productSpaceId");
    const { userId } = callerIdentity(c);
    if (!userId) return c.json({ error_code: "unauthorized", message: "Missing user" }, 401);

    // onboarding_status/template_id ride along from the space's own config_json rather than
    // costing a second round trip per business: Discover's most important call to action is
    // "finish setting this one up", and a business that was created but never configured does
    // nothing at all (its assistant has no account to read and no way to reach its owner). Both
    // are NULL for a business created before templates existed, which the UI reads as "nothing
    // left to do" — the honest default, since there is no checklist to point at.
    const { results } = await env.PLATFORM_DB.prepare(
      `SELECT m.business_space_id AS id, m.role, m.status AS membership_status, m.joined_at,
              s.name, s.status AS space_status,
              json_extract(s.config_json, '$.onboarding.status') AS onboarding_status,
              json_extract(s.config_json, '$.template_id') AS template_id
         FROM business_memberships m
         JOIN spaces s ON s.id = m.business_space_id
        WHERE m.product_space_id = ? AND m.end_user_id = ? AND m.status = 'active' AND s.status != 'deleted'
        ORDER BY m.joined_at ASC`
    ).bind(productSpaceId, userId).all();

    return c.json({ data: results, count: results.length });
  });

  // Step 18: GET /spaces/:productSpaceId/directory — a public-within-the-product directory of
  // ALL active businesses under this product (not just the caller's own), so a signed-in end user
  // can DISCOVER what others have built, but only NAVIGATE into their own. Deliberately scoped to
  // the product (businesses share one product root), NOT platform-wide — that would be a much
  // larger cross-product privacy decision (item 102's boundary). Safe projection only: id, name,
  // template_id, created_at — never owner identity, revenue, or any private metric. `is_mine` is
  // computed from the caller's own business_memberships so the shell can gate navigation.
  app.get("/spaces/:productSpaceId/directory", async (c) => {
    const env = c.env as BusinessRoutesEnv;
    const productSpaceId = c.req.param("productSpaceId");
    const { userId } = callerIdentity(c);
    if (!userId) return c.json({ error_code: "unauthorized", message: "Missing user" }, 401);
    const { results } = await env.PLATFORM_DB.prepare(
      `SELECT s.id, s.name,
              json_extract(s.config_json, '$.template_id') AS template_id,
              s.created_at,
              CASE WHEN m.end_user_id IS NOT NULL THEN 1 ELSE 0 END AS is_mine
         FROM spaces s
         LEFT JOIN business_memberships m
           ON m.business_space_id = s.id AND m.end_user_id = ? AND m.status = 'active'
        WHERE s.parent_space_id = ? AND s.status NOT IN ('deleted', 'error')
        ORDER BY s.created_at DESC
        LIMIT 200`
    ).bind(userId, productSpaceId).all();
    return c.json({ data: results, count: results.length });
  });

  // POST /spaces/:businessSpaceId/invites — owner/admin of the BUSINESS invites a collaborator by
  // email. Returns the raw token exactly once (never stored — only its hash, PBKDF2-password
  // precedent's lighter-weight sibling since this is a high-entropy random value, not a
  // user-chosen secret). The caller must resolve their OWN role on this business first, via the
  // same resolveEndUserBusinessRole gate requireBusinessMembership uses.
  app.post("/spaces/:businessSpaceId/invites", async (c) => {
    const env = c.env as BusinessRoutesEnv;
    const businessSpaceId = c.req.param("businessSpaceId");
    const { userId, role: callerPlatformRole } = callerIdentity(c);
    if (!userId) return c.json({ error_code: "unauthorized", message: "Missing user" }, 401);

    // Only a product_end_user caller needs the business-role check (a builder/team caller acting
    // on a business it owns is out of this phase's scope — invites are an end-user-business
    // feature).
    if (callerPlatformRole === "product_end_user") {
      const myRole = await resolveEndUserBusinessRole(env.PLATFORM_DB, businessSpaceId, userId);
      if (myRole !== "owner" && myRole !== "admin") {
        return c.json({ error_code: "forbidden", message: "Only a business owner or admin can invite" }, 403);
      }
    }

    const body = await c.req.json<{ email: string; role?: "member" | "admin" | "owner" }>().catch(() => null);
    if (!body?.email) return c.json({ error_code: "bad_request", message: "email is required" }, 400);

    const business = await env.PLATFORM_DB.prepare(
      "SELECT parent_space_id, tenant_id FROM spaces WHERE id = ? AND status != 'deleted'"
    ).bind(businessSpaceId).first<{ parent_space_id: string | null; tenant_id: string }>();
    if (!business?.parent_space_id) {
      return c.json({ error_code: "not_found", message: "Business not found" }, 404);
    }

    // Phase 4 (money): "a personal plan gates ... whether others may join" — the CALLER's own
    // personal-plan tier (the person issuing the invite, already confirmed owner/admin above)
    // must allow inviting at all. A builder/team caller (checked via callerPlatformRole above)
    // is unaffected — this only applies to a product_end_user acting as a business owner/admin.
    //
    // DELIBERATELY ONLY ENFORCED when the product actually has a real personalPlans checkout
    // configured (pc.pricingConfig.personalPlans non-empty) — this feature is brand new and no
    // existing end user has ever purchased a personal plan, so gating invites unconditionally
    // would instantly break every currently-working invite flow on every live business with no
    // way for anyone to fix it (there'd be nothing to upgrade TO). Matches this codebase's own
    // "never gate on a monetization control nobody can actually satisfy" precedent
    // (free_tier_eligible's own template-catalog gate has the identical shape).
    if (callerPlatformRole === "product_end_user") {
      const productRoot = await env.PLATFORM_DB.prepare(
        "SELECT tenant_id, spacetype_id, config_json FROM spaces WHERE id = ? AND status != 'deleted'"
      ).bind(business.parent_space_id).first<{ tenant_id: string; spacetype_id: string; config_json: string | null }>();
      if (productRoot) {
        const pc = await loadEffectiveProductConfig(env, productRoot.spacetype_id, productRoot.config_json);
        const hasRealUpgradePath = ((pc as { pricingConfig?: { personalPlans?: unknown[] } })?.pricingConfig?.personalPlans?.length ?? 0) > 0;
        if (hasRealUpgradePath) {
          const tier = await resolvePersonalPlanTier(env, business.parent_space_id, userId, productRoot.tenant_id);
          if (!canPersonalPlanInvite(tier)) {
            return c.json(
              { error_code: "personal_plan_invite_not_allowed", message: "Your personal plan doesn't allow inviting others yet — upgrade to invite collaborators." },
              403
            );
          }
        }
      }
    }

    const id = crypto.randomUUID();
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const email = body.email.trim().toLowerCase();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await env.PLATFORM_DB.prepare(
      `INSERT INTO business_invites (id, business_space_id, product_space_id, email, role, token_hash, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, businessSpaceId, business.parent_space_id, email, body.role ?? "member", tokenHash, userId, expiresAt).run();

    // F-15: email the invitee (best-effort). Resolve the product's slug for a clickable link.
    const product = await env.PLATFORM_DB.prepare(
      "SELECT product_slug FROM spaces WHERE id = ?"
    ).bind(business.parent_space_id).first<{ product_slug: string | null }>();
    await sendInviteEmail(env, business.tenant_id, businessSpaceId, email, businessSpaceId, token, product?.product_slug ?? null);

    return c.json({ id, token, expires_at: expiresAt }, 201);
  });

  // POST /spaces/:businessSpaceId/invites/:token/accept — the signed-in end user (their OWN
  // product session — see the router allowlist comment for why this is product_end_user-gated
  // rather than the plan's originally-sketched fully unauthenticated route: an invite grants
  // membership in something real, and this codebase's convention is to authenticate the accepting
  // identity rather than trust an emailed link alone) redeems a single-use, expiring token.
  app.post("/spaces/:businessSpaceId/invites/:token/accept", async (c) => {
    const env = c.env as BusinessRoutesEnv;
    const businessSpaceId = c.req.param("businessSpaceId");
    const token = c.req.param("token");
    const { userId } = callerIdentity(c);
    if (!userId) return c.json({ error_code: "unauthorized", message: "Missing user" }, 401);

    const tokenHash = await sha256Hex(token);
    const invite = await env.PLATFORM_DB.prepare(
      `SELECT id, role, expires_at, accepted_at FROM business_invites
        WHERE business_space_id = ? AND token_hash = ?`
    ).bind(businessSpaceId, tokenHash).first<{ id: string; role: string; expires_at: string; accepted_at: string | null }>();
    if (!invite) return c.json({ error_code: "not_found", message: "Invite not found" }, 404);
    if (invite.accepted_at) return c.json({ error_code: "already_accepted", message: "This invite has already been used" }, 409);
    if (new Date(invite.expires_at).getTime() < Date.now()) {
      return c.json({ error_code: "expired", message: "This invite has expired" }, 410);
    }

    const business = await env.PLATFORM_DB.prepare(
      "SELECT tenant_id, parent_space_id FROM spaces WHERE id = ? AND status != 'deleted'"
    ).bind(businessSpaceId).first<{ tenant_id: string; parent_space_id: string | null }>();
    if (!business?.parent_space_id) return c.json({ error_code: "not_found", message: "Business not found" }, 404);

    await env.PLATFORM_DB.prepare(
      "UPDATE business_invites SET accepted_at = datetime('now'), accepted_by = ? WHERE id = ?"
    ).bind(userId, invite.id).run();
    await env.PLATFORM_DB.prepare(
      `INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status, invited_by, joined_at)
       VALUES (?, ?, ?, ?, 'active', NULL, datetime('now'))
       ON CONFLICT(business_space_id, end_user_id) DO UPDATE SET status = 'active', role = excluded.role`
    ).bind(businessSpaceId, business.parent_space_id, userId, invite.role).run();
    await seedSpaceDoMember(env, businessSpaceId, business.tenant_id, userId, invite.role);

    return c.json({ business_space_id: businessSpaceId, role: invite.role });
  });

  // GET /spaces/:businessSpaceId/business-members — a safe projection of business_memberships
  // (NOT the generic SpaceDO members proxy, which stays hardened builder-only per A1.16.10's
  // "never make product customers into SpaceDO members" rule — that rule is about the shared
  // PRODUCT ROOT, not a business the customer themselves owns; business_memberships is the
  // purpose-built index for exactly this population).
  app.get("/spaces/:businessSpaceId/business-members", async (c) => {
    const env = c.env as BusinessRoutesEnv;
    const businessSpaceId = c.req.param("businessSpaceId");
    const { userId, role: callerPlatformRole } = callerIdentity(c);
    if (!userId) return c.json({ error_code: "unauthorized", message: "Missing user" }, 401);

    if (callerPlatformRole === "product_end_user") {
      const myRole = await resolveEndUserBusinessRole(env.PLATFORM_DB, businessSpaceId, userId);
      if (!myRole) return c.json({ error_code: "forbidden", message: "Not a member of this business" }, 403);
    }

    const { results } = await env.PLATFORM_DB.prepare(
      "SELECT end_user_id, role, status, joined_at FROM business_memberships WHERE business_space_id = ? ORDER BY joined_at ASC"
    ).bind(businessSpaceId).all();
    return c.json({ data: results, count: results.length });
  });

  // DELETE /spaces/:businessSpaceId/business-members/:endUserId — owner/admin only; an owner can
  // never be removed this way (must transfer ownership first — out of this phase's scope, so
  // simply disallowed for now rather than left as a footgun).
  app.delete("/spaces/:businessSpaceId/business-members/:endUserId", async (c) => {
    const env = c.env as BusinessRoutesEnv;
    const businessSpaceId = c.req.param("businessSpaceId");
    const targetEndUserId = c.req.param("endUserId");
    const { userId, role: callerPlatformRole } = callerIdentity(c);
    if (!userId) return c.json({ error_code: "unauthorized", message: "Missing user" }, 401);

    if (callerPlatformRole === "product_end_user") {
      const myRole = await resolveEndUserBusinessRole(env.PLATFORM_DB, businessSpaceId, userId);
      if (myRole !== "owner" && myRole !== "admin") {
        return c.json({ error_code: "forbidden", message: "Only a business owner or admin can remove members" }, 403);
      }
    }

    const target = await env.PLATFORM_DB.prepare(
      "SELECT role FROM business_memberships WHERE business_space_id = ? AND end_user_id = ?"
    ).bind(businessSpaceId, targetEndUserId).first<{ role: string }>();
    if (!target) return c.json({ error_code: "not_found", message: "Not a member" }, 404);
    if (target.role === "owner") {
      return c.json({ error_code: "not_allowed", message: "The owner cannot be removed — transfer ownership first" }, 403);
    }

    await env.PLATFORM_DB.prepare(
      "DELETE FROM business_memberships WHERE business_space_id = ? AND end_user_id = ?"
    ).bind(businessSpaceId, targetEndUserId).run();

    return c.json({ deleted: true, business_space_id: businessSpaceId, end_user_id: targetEndUserId });
  });
}
