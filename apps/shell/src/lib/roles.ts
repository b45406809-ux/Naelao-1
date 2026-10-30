// Which business roles may change settings, in one place.
//
// This exists because of a real bug: the dashboard gated its assistant controls on
// `role === "admin"` exactly, while whoever CREATES a business is always inserted as `'owner'`
// (workers/spaces/src/business-routes.ts). The backend ranks owner(3) >= admin(2)
// (business-auth.ts's ROLE_RANK), so the server would happily have accepted the write — but the
// UI never offered it, and every business creator saw their own settings read-only.
//
// The lesson is that an exact-match role check silently drifts from a ranked one. So the rank is
// mirrored here, once, and every surface asks this rather than comparing strings itself.

export type SpaceRole = "viewer" | "member" | "admin" | "owner";

/** Mirrors workers/spaces/src/business-auth.ts's ROLE_RANK. Keep the two in step — a role added
 *  there but not here reads as "no access" in the UI, which fails safe but silently. */
const ROLE_RANK: Record<SpaceRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: string | null | undefined, minimum: SpaceRole): boolean {
  if (!role) return false;
  const rank = ROLE_RANK[role as SpaceRole];
  if (rank === undefined) return false;
  return rank >= ROLE_RANK[minimum];
}

/** Can this caller change the space's or an agent's configuration? The same floor
 *  `requireSpaceMembership({ PATCH: "admin" })` enforces server-side. `isChildSpace` is part
 *  of the question: on a product root (team mode) an end user is never more than a member, so
 *  those settings belong to the builder dashboard, not here. */
export function canManageSpaceSettings(isChildSpace: boolean, role: string | null | undefined): boolean {
  return isChildSpace && roleAtLeast(role, "admin");
}
