/** Sovereign knowledge roles. Each role occupies one bit so document access is a single AND. */
export const KNOWLEDGE_ROLE_MASK = {
  owner: 0b00010000,
  admin: 0b00001000,
  editor: 0b00000100,
  member: 0b00000010,
  viewer: 0b00000001,
} as const;

export type KnowledgeRole = keyof typeof KNOWLEDGE_ROLE_MASK;
export type KnowledgeScope = "USER_PRIVATE" | "PROJECT_BOUND" | "SPACE_WIDE";

export interface KnowledgeCallerClaims {
  userId: string;
  role: KnowledgeRole;
  /** A verified space membership, supplied by the authentication boundary. */
  spaceIds: readonly string[];
  /** Verified project memberships. Owners/admins are not implicitly added to private projects. */
  projectIds?: readonly string[];
}

export interface KnowledgeClearance {
  userId: string;
  role: KnowledgeRole;
  roleMask: number;
  spaceId: string;
  projectId?: string;
  scope: KnowledgeScope;
  allowedUserIds: readonly string[];
}

/** Resolve immutable, verified claims into the least-privileged knowledge clearance. */
export function resolveKnowledgeClearance(
  claims: KnowledgeCallerClaims,
  spaceId: string,
  projectId?: string
): KnowledgeClearance {
  if (!claims.userId || !spaceId || !claims.spaceIds.includes(spaceId)) {
    throw new Error("Knowledge access is not authorized for this space");
  }
  if (projectId && !claims.projectIds?.includes(projectId)) {
    throw new Error("Knowledge access is not authorized for this project");
  }
  return {
    userId: claims.userId,
    role: claims.role,
    roleMask: KNOWLEDGE_ROLE_MASK[claims.role],
    spaceId,
    ...(projectId ? { projectId } : {}),
    scope: projectId ? "PROJECT_BOUND" : "SPACE_WIDE",
    allowedUserIds: [claims.userId],
  };
}

/** Mathematical clearance predicate used at ingestion/tests; retrieval is enforced in Vectorize. */
export function hasKnowledgeBitmaskAccess(
  documentMask: number,
  userMask: number
): boolean {
  return (
    Number.isInteger(documentMask) &&
    Number.isInteger(userMask) &&
    (documentMask & userMask) !== 0
  );
}
