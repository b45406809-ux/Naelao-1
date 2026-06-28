/**
 * Business access control (tenant isolation at the API layer).
 *
 * The `/business/:userId/*` routes carry a userId in the path. In the three-tier
 * model a regular USER runs exactly one business and may only touch their own;
 * the founder (admin/owner) has dev access to any business (the dev dashboard).
 * This complements the HMAC-derived DO names — names are unguessable AND the API
 * refuses a cross-user request.
 *
 * Pure and dependency-free so it is unit-testable.
 */

/**
 * @param authedUserId  the authenticated caller's id (x-naelao-user-id), or "" if none
 * @param role          the caller's role (x-naelao-role)
 * @param pathUserId    the :userId in the route
 *
 * No identity → internal/worker-to-worker call (the agents worker is only reachable
 * behind the router, which always sets identity for external traffic) → allowed.
 */
export function canAccessBusiness(authedUserId: string, role: string, pathUserId: string): boolean {
  if (!authedUserId) return true;                       // internal call (no router identity)
  if (role === "admin" || role === "owner") return true; // founder / dev access to any business
  return authedUserId === pathUserId;                    // users: only their own business
}
