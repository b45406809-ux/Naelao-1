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
  endUserId: string,
  tenantId?: string
): Promise<SpaceRole | null> {
  if (!spaceId || !endUserId) return null;
  try {
    const direct = await db.prepare(
      `SELECT sm.role
       FROM spaces s
       JOIN space_members sm ON sm.space_id = s.id
       WHERE s.id = ? AND s.status != 'deleted'
         AND (? IS NULL OR s.tenant_id = ?)
         AND sm.end_user_id = ? AND sm.suspended_at IS NULL`
    ).bind(spaceId, tenantId ?? null, tenantId ?? null, endUserId).first<{ role: string }>();
    if (direct) {
      const role = direct.role === "moderator" ? "admin" : direct.role;
      return (["viewer", "member", "admin", "owner"] as string[]).includes(role)
        ? role as SpaceRole
        : null;
    }
    return null;
  } catch {
    return null;
  }
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
    // Resolve on every protected request. Positive role caching allowed a revoked member to keep
    // using a warm isolate until TTL expiry; authorization changes must take effect immediately.
    // The joined lookup also binds Space and membership rows to the authenticated tenant in one D1 read.
    const callerRole = await resolveEndUserSpaceRole(env.PLATFORM_DB, spaceId, endUserId, tenantId);
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
