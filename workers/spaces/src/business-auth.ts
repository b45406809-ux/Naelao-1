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
// Phase C (§A1.17) upgraded this from Phase B's flat "every product_end_user is a member"
// constant to a REAL per-business lookup — closing a genuine cross-business access hole the
// phased plan flagged in advance: `resolveProductEndUserClaims` only proves the caller holds a
// valid ProductUserDO session scoped to the PRODUCT (one ProductUserDO per productId×endUserId,
// not per-business), so a session verified for the product root would, without this lookup, also
// satisfy the identity check for ANY business under that product — a caller could simply change
// the :spaceId in the URL to reach a different end user's business. `resolveEndUserBusinessRole`
// closes this: the product ROOT space (no parent_space_id) keeps Phase B's behavior (a verified
// session for that exact space implies "member" — safe, since the session literally IS scoped to
// it), but a BUSINESS space (parent_space_id set) requires an ACTIVE row in `business_memberships`
// — no row, no access, regardless of whether the caller is a valid end user of the product.

import { createMiddleware } from "hono/factory";

export type BusinessRole = "viewer" | "member" | "admin" | "owner";

const ROLE_RANK: Record<BusinessRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

interface BusinessAuthEnv {
  PLATFORM_DB: D1Database;
}

/** Resolve the real role an end user holds on `spaceId`. Returns null when the caller has NO
 *  access at all (a business they aren't a member of) — callers must treat null as forbidden,
 *  never fall back to a default role. Fails closed on any lookup error. */
export async function resolveEndUserBusinessRole(
  db: D1Database,
  spaceId: string,
  endUserId: string
): Promise<BusinessRole | null> {
  if (!spaceId || !endUserId) return null;
  try {
    const space = await db.prepare("SELECT parent_space_id FROM spaces WHERE id = ? AND status != 'deleted'")
      .bind(spaceId).first<{ parent_space_id: string | null }>();
    if (!space) return null;
    if (!space.parent_space_id) {
      // The product root — resolveProductEndUserClaims already proved a valid session scoped to
      // exactly this space, so "member" is safe here (this is the Phase B behavior, unchanged).
      return "member";
    }
    const membership = await db.prepare(
      "SELECT role FROM business_memberships WHERE business_space_id = ? AND end_user_id = ? AND status = 'active'"
    ).bind(spaceId, endUserId).first<{ role: string }>();
    if (!membership) return null;
    return membership.role as BusinessRole;
  } catch {
    return null;
  }
}

// WS-7 (audit plan): this check runs on every business-scoped end-user request, doing 1-2
// PLATFORM_DB (single-instance D1, per CLAUDE.md) reads each time — a real chokepoint at
// "millions of end-users" scale. Short-TTL in-memory cache, same pattern as the router's own
// per-user token-version cache (5s TTL): a warm isolate skips the D1 round trip for a burst of
// requests from the same (spaceId, endUserId), while a revoked/changed membership is picked up
// again within a few seconds. Deliberately only wraps the MIDDLEWARE call site, not the exported
// `resolveEndUserBusinessRole` function itself — that function is called directly (uncached) by
// existing tests asserting on membership changes taking effect immediately after a DB mutation;
// caching belongs to the request-serving path, not the primitive.
const BUSINESS_ROLE_CACHE_TTL_MS = 5_000;
const BUSINESS_ROLE_CACHE_MAX = 2000;
const businessRoleCache = new Map<string, { role: BusinessRole | null; expiresAt: number }>();

async function resolveEndUserBusinessRoleCached(
  db: D1Database,
  spaceId: string,
  endUserId: string
): Promise<BusinessRole | null> {
  const cacheKey = `${spaceId}:${endUserId}`;
  const cached = businessRoleCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.role;
  const role = await resolveEndUserBusinessRole(db, spaceId, endUserId);
  if (businessRoleCache.size >= BUSINESS_ROLE_CACHE_MAX) {
    businessRoleCache.delete(businessRoleCache.keys().next().value!);
  }
  businessRoleCache.set(cacheKey, { role, expiresAt: Date.now() + BUSINESS_ROLE_CACHE_TTL_MS });
  return role;
}

/** Wallet-specific variant of resolveEndUserBusinessRole. The product ROOT space's wallet project
 *  (seeded by seedWallet, kind='wallet') is the BUILDER's own platform-cost ledger — unlike every
 *  other root-scoped resource, a verified end-user product session implies NO legitimate access to
 *  it, so the generic root-is-"member" shortcut must NOT apply here. A business (child) space's
 *  wallet is that business's own money, so it keeps the normal per-business membership lookup. */
export async function resolveWalletAccessRole(
  db: D1Database,
  spaceId: string,
  endUserId: string
): Promise<BusinessRole | null> {
  if (!spaceId || !endUserId) return null;
  try {
    const space = await db.prepare("SELECT parent_space_id FROM spaces WHERE id = ? AND status != 'deleted'")
      .bind(spaceId).first<{ parent_space_id: string | null }>();
    if (!space) return null;
    if (!space.parent_space_id) return null; // product root: builder-only, never a product_end_user
    const membership = await db.prepare(
      "SELECT role FROM business_memberships WHERE business_space_id = ? AND end_user_id = ? AND status = 'active'"
    ).bind(spaceId, endUserId).first<{ role: string }>();
    if (!membership) return null;
    return membership.role as BusinessRole;
  } catch {
    return null;
  }
}

const walletRoleCache = new Map<string, { role: BusinessRole | null; expiresAt: number }>();

async function resolveWalletAccessRoleCached(
  db: D1Database,
  spaceId: string,
  endUserId: string
): Promise<BusinessRole | null> {
  const cacheKey = `${spaceId}:${endUserId}`;
  const cached = walletRoleCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.role;
  const role = await resolveWalletAccessRole(db, spaceId, endUserId);
  if (walletRoleCache.size >= BUSINESS_ROLE_CACHE_MAX) {
    walletRoleCache.delete(walletRoleCache.keys().next().value!);
  }
  walletRoleCache.set(cacheKey, { role, expiresAt: Date.now() + BUSINESS_ROLE_CACHE_TTL_MS });
  return role;
}

/** Returns a Hono middleware that, ONLY for `x-naelao-role: product_end_user` callers, requires
 *  at least `methodMinRole[method]` (default: "admin", fail closed for methods not listed) on the
 *  space named by the `spaceId` route param. Every other role passes through untouched. */
export function requireBusinessMembership(methodMinRole: Partial<Record<string, BusinessRole>>) {
  return createMiddleware(async (c, next) => {
    const role = c.req.header("x-naelao-role") ?? "";
    if (role !== "product_end_user") return next();

    const spaceId = c.req.param("spaceId") ?? "";
    const endUserId = c.req.header("x-naelao-user-id") ?? "";
    const env = c.env as BusinessAuthEnv;
    const callerRole = await resolveEndUserBusinessRoleCached(env.PLATFORM_DB, spaceId, endUserId);
    if (!callerRole) {
      return c.json({ error_code: "forbidden", message: "Not a member of this business" }, 403);
    }
    const minRole = methodMinRole[c.req.method] ?? "admin";
    if (ROLE_RANK[callerRole] < ROLE_RANK[minRole]) {
      return c.json({ error_code: "forbidden", message: "Insufficient role for this action" }, 403);
    }
    return next();
  });
}

/** Wallet-only variant of requireBusinessMembership: uses resolveWalletAccessRole instead of
 *  resolveEndUserBusinessRole, so a product_end_user is refused OUTRIGHT on the product ROOT
 *  space's wallet (the builder's own platform-cost ledger) instead of passing at the generic
 *  root-implies-"member" floor. Business (child) space wallets are unaffected — same real
 *  business_memberships lookup as every other business-scoped route. Every non-product_end_user
 *  caller (builder JWT roles) passes through untouched, as with requireBusinessMembership. */
export function requireBusinessMembershipForWallet(methodMinRole: Partial<Record<string, BusinessRole>>) {
  return createMiddleware(async (c, next) => {
    const role = c.req.header("x-naelao-role") ?? "";
    if (role !== "product_end_user") return next();

    const spaceId = c.req.param("spaceId") ?? "";
    const endUserId = c.req.header("x-naelao-user-id") ?? "";
    const env = c.env as BusinessAuthEnv;
    const callerRole = await resolveWalletAccessRoleCached(env.PLATFORM_DB, spaceId, endUserId);
    if (!callerRole) {
      return c.json({ error_code: "forbidden", message: "Wallet is not accessible to end users on this space" }, 403);
    }
    const minRole = methodMinRole[c.req.method] ?? "admin";
    if (ROLE_RANK[callerRole] < ROLE_RANK[minRole]) {
      return c.json({ error_code: "forbidden", message: "Insufficient role for this action" }, 403);
    }
    return next();
  });
}
