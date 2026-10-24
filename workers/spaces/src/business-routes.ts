// Three-Tier Platform Model, Phase C (docs/spec-appendix/A1-script-agents-and-space-assistants.md
// §A1.17) — businesses, the space switcher, and invites.
//
// registerBusinessRoutes(app) is called once from index.ts, same convention as
// registerBuilderRoutes/registerProductEndUserRoutes: a self-contained module with its own
// minimal structural Env (avoids a circular import with index.ts).

import type { Hono } from "hono";
import { verifyInternalToken } from "@naelao/http";
import { getDOName } from "@naelao/crypto";
import { resolveEndUserBusinessRole } from "./business-auth.js";

export interface BusinessRoutesEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
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

async function authorizeProductUser(
  env: BusinessRoutesEnv,
  c: { req: { header(h: string): string | undefined } },
  spaceId: string,
): Promise<{ tenantId: string; userId: string } | null> {
  const identity = callerIdentity(c);
  if (!identity.tenantId || !identity.userId || identity.role !== "product_end_user" ||
      !await verifyInternalToken(c.req.header("x-naelao-internal-token"), identity.tenantId, env.PLATFORM_SECRET)) return null;
  const space = await env.PLATFORM_DB.prepare("SELECT tenant_id, parent_space_id FROM spaces WHERE id = ? AND status != 'deleted'")
    .bind(spaceId).first<{ tenant_id: string; parent_space_id: string | null }>();
  if (!space || space.tenant_id !== identity.tenantId) return null;
  const productId = space.parent_space_id ?? spaceId;
  const roster = await env.PLATFORM_DB.prepare(
    "SELECT 1 AS active FROM product_end_users WHERE product_space_id = ? AND end_user_id = ? AND suspended_at IS NULL AND deleted_at IS NULL"
  ).bind(productId, identity.userId).first();
  return roster ? { tenantId: identity.tenantId, userId: identity.userId } : null;
}

export function registerBusinessRoutes(app: Hono<any>): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  // GET /spaces/:productSpaceId/my-businesses — the space switcher's list: every business (under
  // this product) the calling end user belongs to, from the business_memberships index (never
  // opens each business's own SpaceDO — that's exactly what this index exists to avoid at scale).
  app.get("/spaces/:productSpaceId/my-businesses", async (c) => {
    const env = c.env as BusinessRoutesEnv;
    const productSpaceId = c.req.param("productSpaceId");
    const identity = await authorizeProductUser(env, c, productSpaceId);
    if (!identity) return c.json({ error_code: "forbidden", message: "Signed product end-user identity required" }, 403);
    const { userId } = identity;

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

  // POST /spaces/:businessSpaceId/invites — owner/admin of the BUSINESS invites a collaborator by
  // email. Returns the raw token exactly once (never stored — only its hash, PBKDF2-password
  // precedent's lighter-weight sibling since this is a high-entropy random value, not a
  // user-chosen secret). The caller must resolve their OWN role on this business first, via the
  // same resolveEndUserBusinessRole gate requireBusinessMembership uses.
  app.post("/spaces/:businessSpaceId/invites", async (c) => {
    const env = c.env as BusinessRoutesEnv;
    const businessSpaceId = c.req.param("businessSpaceId");
    const identity = await authorizeProductUser(env, c, businessSpaceId);
    if (!identity) return c.json({ error_code: "forbidden", message: "Signed product end-user identity required" }, 403);
    const { userId } = identity;
    const myRole = await resolveEndUserBusinessRole(env.PLATFORM_DB, businessSpaceId, userId);
    if (myRole !== "owner" && myRole !== "admin") {
      return c.json({ error_code: "forbidden", message: "Only a business owner or admin can invite" }, 403);
    }

    const body = await c.req.json<{ email: string; role?: "member" | "admin" | "owner" }>().catch(() => null);
    if (!body || typeof body.email !== "string" || body.email.trim().length < 3 || body.email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
        (body.role !== undefined && body.role !== "member" && body.role !== "admin")) return c.json({ error_code: "bad_request", message: "A valid invite email and member/admin role are required" }, 400);

    const business = await env.PLATFORM_DB.prepare(
      "SELECT parent_space_id, tenant_id FROM spaces WHERE id = ? AND status != 'deleted'"
    ).bind(businessSpaceId).first<{ parent_space_id: string | null; tenant_id: string }>();
    if (!business?.parent_space_id) {
      return c.json({ error_code: "not_found", message: "Business not found" }, 404);
    }
    await env.PLATFORM_DB.prepare(
      "DELETE FROM business_invites WHERE business_space_id = ? AND ((accepted_at IS NOT NULL AND julianday(accepted_at) < julianday('now', '-30 days')) OR julianday(expires_at) < julianday('now', '-30 days'))"
    ).bind(businessSpaceId).run();
    const pending = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS count FROM business_invites WHERE business_space_id = ? AND accepted_at IS NULL AND julianday(expires_at) > julianday('now')"
    ).bind(businessSpaceId).first<{ count: number }>();
    if ((pending?.count ?? 0) >= 100) return c.json({ error_code: "invite_limit_reached", message: "This business has reached its pending invite limit" }, 429);
    const history = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS count FROM business_invites WHERE business_space_id = ?")
      .bind(businessSpaceId).first<{ count: number }>();
    if ((history?.count ?? 0) >= 500) return c.json({ error_code: "invite_history_limit_reached", message: "This business has reached its invite history limit" }, 429);

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
    const identity = await authorizeProductUser(env, c, businessSpaceId);
    if (!identity) return c.json({ error_code: "forbidden", message: "Signed product end-user identity required" }, 403);
    const { userId } = identity;
    if (!/^inv_[a-f0-9]{48}$/.test(token)) return c.json({ error_code: "invalid_token", message: "Invite token is invalid" }, 400);

    const tokenHash = await sha256Hex(token);
    const invite = await env.PLATFORM_DB.prepare(
      `SELECT id, role, email, expires_at, accepted_at FROM business_invites
        WHERE business_space_id = ? AND token_hash = ?`
    ).bind(businessSpaceId, tokenHash).first<{ id: string; role: string; email: string; expires_at: string; accepted_at: string | null }>();
    if (!invite) return c.json({ error_code: "not_found", message: "Invite not found" }, 404);
    if (invite.accepted_at) return c.json({ error_code: "already_accepted", message: "This invite has already been used" }, 409);
    const inviteExpiresAt = Date.parse(invite.expires_at);
    if (!Number.isFinite(inviteExpiresAt) || inviteExpiresAt <= Date.now()) {
      return c.json({ error_code: "expired", message: "This invite has expired" }, 410);
    }
    if (invite.role !== "member" && invite.role !== "admin") return c.json({ error_code: "invalid_invite_role", message: "This invite has an unsupported role" }, 409);

    const business = await env.PLATFORM_DB.prepare(
      "SELECT tenant_id, parent_space_id FROM spaces WHERE id = ? AND status != 'deleted'"
    ).bind(businessSpaceId).first<{ tenant_id: string; parent_space_id: string | null }>();
    if (!business?.parent_space_id) return c.json({ error_code: "not_found", message: "Business not found" }, 404);

    const account = await env.PLATFORM_DB.prepare("SELECT email FROM product_end_users WHERE product_space_id = ? AND end_user_id = ? AND suspended_at IS NULL AND deleted_at IS NULL")
      .bind(business.parent_space_id, userId).first<{ email: string | null }>();
    if (!account?.email || account.email.trim().toLowerCase() !== invite.email.trim().toLowerCase()) {
      return c.json({ error_code: "invite_email_mismatch", message: "Sign in with the email address this invitation was sent to" }, 403);
    }
    const memberCount = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS count FROM business_memberships WHERE business_space_id = ? AND status = 'active'")
      .bind(businessSpaceId).first<{ count: number }>();
    if ((memberCount?.count ?? 0) >= 1000) return c.json({ error_code: "business_member_limit_reached", message: "This business has reached its member limit" }, 429);

    const claimed = await env.PLATFORM_DB.prepare(
      "UPDATE business_invites SET accepted_at = datetime('now'), accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND julianday(expires_at) > julianday('now')"
    ).bind(userId, invite.id).run();
    if (claimed.meta.changes === 0) return c.json({ error_code: "already_accepted", message: "This invite has already been used" }, 409);
    try {
      await env.PLATFORM_DB.prepare(
        `INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status, invited_by, joined_at)
         VALUES (?, ?, ?, ?, 'active', NULL, datetime('now'))
         ON CONFLICT(business_space_id, end_user_id) DO UPDATE SET status = 'active',
           role = CASE WHEN business_memberships.role = 'owner' THEN 'owner' ELSE excluded.role END`
      ).bind(businessSpaceId, business.parent_space_id, userId, invite.role).run();
    } catch (error) {
      await env.PLATFORM_DB.prepare("UPDATE business_invites SET accepted_at = NULL, accepted_by = NULL WHERE id = ? AND accepted_by = ?").bind(invite.id, userId).run().catch(() => undefined);
      throw error;
    }
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
    const identity = await authorizeProductUser(env, c, businessSpaceId);
    if (!identity) return c.json({ error_code: "forbidden", message: "Signed product end-user identity required" }, 403);
    const { userId } = identity;
    const myRole = await resolveEndUserBusinessRole(env.PLATFORM_DB, businessSpaceId, userId);
    if (!myRole) return c.json({ error_code: "forbidden", message: "Not a member of this business" }, 403);

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
    const identity = await authorizeProductUser(env, c, businessSpaceId);
    if (!identity) return c.json({ error_code: "forbidden", message: "Signed product end-user identity required" }, 403);
    const { userId, tenantId } = identity;
    const myRole = await resolveEndUserBusinessRole(env.PLATFORM_DB, businessSpaceId, userId);
    if (myRole !== "owner" && myRole !== "admin") {
      return c.json({ error_code: "forbidden", message: "Only a business owner or admin can remove members" }, 403);
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

    try {
      const doId = env.SPACE_DO.idFromName(await getDOName("space", businessSpaceId, tenantId, env.PLATFORM_SECRET));
      await env.SPACE_DO.get(doId).fetch(new Request(`http://space-do/members/${encodeURIComponent(targetEndUserId)}?space_id=${encodeURIComponent(businessSpaceId)}`, { method: "DELETE" }));
    } catch { /* D1 remains authoritative for route authorization; the SpaceDO mirror is best effort. */ }

    return c.json({ deleted: true, business_space_id: businessSpaceId, end_user_id: targetEndUserId });
  });
}
