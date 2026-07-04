// Three-Tier Platform Model, Phase B (§A1.17): the extra authorization floor a `product_end_user`
// caller needs on routes that were previously builder-only. These routes (projects, threads,
// agent-definitions, presence) are gated by `requireInternalHmac` for "did this request actually
// come through the router" — that check passes for a product_end_user exactly the same as a
// builder, since `proxyTo` mints the internal token off ANY verified claims, role included. What
// was MISSING is a floor on what a product_end_user is allowed to do once past that gate.
//
// For Phase B there is no real per-business role yet — `resolveProductEndUserClaims` only proves
// the caller holds a valid ProductUserDO session scoped to this exact space, which is treated as
// "member" of the product root. Phase C's `business_memberships` index replaces this with a real
// owner/admin/member lookup once end users can own/administer their own businesses; nothing here
// should be read as a permanent authority model.
//
// Deliberately additive-only: a non-product_end_user caller (any builder JWT role) always passes
// unchanged — this file only adds a new floor for the new population, it never re-litigates
// existing builder authorization.

import { createMiddleware } from "hono/factory";

export type BusinessRole = "viewer" | "member" | "admin" | "owner";

const ROLE_RANK: Record<BusinessRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** Phase B: every verified product_end_user is a "member". Phase C replaces this constant
 *  mapping with a real per-business role lookup. */
export function productEndUserBusinessRole(): BusinessRole {
  return "member";
}

/** Returns a Hono middleware that, ONLY for `x-naelao-role: product_end_user` callers, requires
 *  at least `methodMinRole[method]` (default: "admin", fail closed for methods not listed). Every
 *  other role passes through untouched. */
export function requireBusinessMembership(methodMinRole: Partial<Record<string, BusinessRole>>) {
  return createMiddleware(async (c, next) => {
    const role = c.req.header("x-naelao-role") ?? "";
    if (role !== "product_end_user") return next();

    const minRole = methodMinRole[c.req.method] ?? "admin";
    const callerRole = productEndUserBusinessRole();
    if (ROLE_RANK[callerRole] < ROLE_RANK[minRole]) {
      return c.json({ error_code: "forbidden", message: "Insufficient role for this action" }, 403);
    }
    return next();
  });
}
