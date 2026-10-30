// Three-Tier Platform Model (§A1.17): the extra authorization floor a `product_end_user` caller
// needs on routes that were previously builder-only. These routes (projects, threads,
// agent-definitions, presence) are gated by `requireInternalHmac` for "did this request actually
// come through the router" — that check passes for a product_end_user exactly the same as a
// builder, since `proxyTo` mints the internal token off ANY verified claims, role included. What
// was MISSING is a floor on what a product_end_user is allowed to do once past that gate.
//
// Deliberately additive-only: a non-product_end_user caller (any builder JWT role) always passes
// unchanged — this file only adds a new floor for the new population, it never re-litigates
// existing builder authorization.
//
// Product sessions establish identity, while this membership lookup authorizes that identity on
// the requested Space. Every Space requires its own explicit membership row; child membership
// never grants access to a parent or sibling.

import { createMiddleware } from "hono/factory";
import { KNOWLEDGE_ROLE_MASK, type KnowledgeRole } from "@naelao/security";

export type SpaceRole = "viewer" | "member" | "admin" | "owner";

const ROLE_RANK: Record<SpaceRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

function parseSpaceRole(value: string): SpaceRole | null {
  return value === "viewer" || value === "member" || value === "admin" || value === "owner"
    ? value
    : null;
}

/** Canonical bit carried into knowledge indexing/query claims for Space members. */
export function spaceRoleKnowledgeMask(role: SpaceRole): number {
  return KNOWLEDGE_ROLE_MASK[role as KnowledgeRole];
}

interface SpaceAuthEnv {
  PLATFORM_DB: D1Database;
}

/** Resolve the real role an end user holds on `spaceId`. Returns null when the caller has no
 *  membership on that Space — callers must treat null as forbidden,
 *  never fall back to a default role. Fails closed on any lookup error. */
export async function resolveEndUserSpaceRole(
  db: D1Database,
  spaceId: string,
  endUserId: string
): Promise<SpaceRole | null> {
  if (!spaceId || !endUserId) return null;
  try {
    const space = await db.prepare("SELECT id FROM spaces WHERE id = ? AND status != 'deleted'")
      .bind(spaceId).first<{ id: string }>();
    if (!space) return null;
    const direct = await db.prepare(
      "SELECT role FROM space_members WHERE space_id = ? AND end_user_id = ? AND suspended_at IS NULL"
    ).bind(spaceId, endUserId).first<{ role: string }>();
    if (direct) {
      const role = direct.role === "moderator" ? "admin" : direct.role;
      return (["viewer", "member", "admin", "owner"] as string[]).includes(role)
        ? role as SpaceRole
        : "member";
    }
    return null;
  } catch {
    return null;
  }
}

// This check runs on each Space-scoped end-user request, doing at most two
// PLATFORM_DB (single-instance D1, per CLAUDE.md) reads each time — a real chokepoint at
// "millions of end-users" scale. Short-TTL in-memory cache, same pattern as the router's own
// per-user token-version cache (5s TTL): a warm isolate skips the D1 round trip for a burst of
// requests from the same (spaceId, endUserId), while a revoked/changed membership is picked up
// again within a few seconds. Deliberately only wraps the MIDDLEWARE call site, not the exported
// `resolveEndUserSpaceRole` function itself — that function is called directly (uncached) by
// existing tests asserting on membership changes taking effect immediately after a DB mutation;
// caching belongs to the request-serving path, not the primitive.
const SPACE_ROLE_CACHE_TTL_MS = 5_000;
const SPACE_ROLE_CACHE_MAX = 2000;
const spaceRoleCache = new Map<string, { role: SpaceRole | null; expiresAt: number }>();

async function resolveEndUserSpaceRoleCached(
  db: D1Database,
  tenantId: string,
  spaceId: string,
  endUserId: string
): Promise<SpaceRole | null> {
  const cacheKey = `${tenantId}:${spaceId}:${endUserId}`;
  const cached = spaceRoleCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.role;
  const role = await resolveEndUserSpaceRole(db, spaceId, endUserId);
  if (spaceRoleCache.size >= SPACE_ROLE_CACHE_MAX) {
    spaceRoleCache.delete(spaceRoleCache.keys().next().value!);
  }
  spaceRoleCache.set(cacheKey, { role, expiresAt: Date.now() + SPACE_ROLE_CACHE_TTL_MS });
  return role;
}

/** Returns a Hono middleware that, ONLY for `x-naelao-role: product_end_user` callers, requires
 *  at least `methodMinRole[method]` (default: "admin", fail closed for methods not listed) on the
 *  space named by the `spaceId` route param. Every other role passes through untouched. */
export function requireSpaceMembership(methodMinRole: Partial<Record<string, SpaceRole>>) {
  return createMiddleware(async (c, next) => {
    const role = c.req.header("x-naelao-role") ?? "";
    if (role !== "product_end_user") return next();

    const spaceId = c.req.param("spaceId") ?? "";
    const endUserId = c.req.header("x-naelao-user-id") ?? "";
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const env = c.env as SpaceAuthEnv;
    const callerRole = await resolveEndUserSpaceRoleCached(env.PLATFORM_DB, tenantId, spaceId, endUserId);
    if (!callerRole) {
      return c.json({ error_code: "forbidden", message: "Not a member of this Space" }, 403);
    }
    const minRole = methodMinRole[c.req.method] ?? "admin";
    if (ROLE_RANK[callerRole] < ROLE_RANK[minRole]) {
      return c.json({ error_code: "forbidden", message: "Insufficient role for this action" }, 403);
    }
    return next();
  });
}
