export type KnowledgeRole = "owner" | "admin" | "editor" | "member" | "viewer";

export const SPACE_WIDE_PROJECT_ID = "_space";

export interface PermissionedVectorFilter {
  spaceId: string;
  tenantId?: string;
  projectId?: string;
  role: KnowledgeRole;
  roleMask: number;
  userId: string;
  topK?: number;
}

type QueryableVectorIndex = Pick<VectorizeIndex, "query">;

/** Numerically safe cosine similarity used by intent de-duplication callers. */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : Math.max(-1, Math.min(1, dot / denominator));
}

/**
 * Query Vectorize with the complete ACL in its metadata filter. No result is ever ranked before
 * tenant, space, project and sovereign-user permission checks have been applied by the index.
 */
export async function searchPermissionedKnowledge(
  vectorize: QueryableVectorIndex,
  queryEmbedding: number[],
  options: PermissionedVectorFilter
): Promise<VectorizeMatches> {
  if (
    !options.spaceId ||
    !options.userId ||
    !Number.isInteger(options.roleMask)
  ) {
    throw new Error("Complete knowledge clearance is required");
  }
  const filter: Record<string, unknown> = {
    space_id: { $eq: options.spaceId },
    ...(options.tenantId ? { tenant_id: { $eq: options.tenantId } } : {}),
    ...(options.projectId
      ? {
          $or: [
            { project_id: { $eq: options.projectId } },
            { project_id: { $eq: SPACE_WIDE_PROJECT_ID } },
          ],
        }
      : { project_id: { $eq: SPACE_WIDE_PROJECT_ID } }),
    $and: [
      {
        $or: [
          { visibility: { $eq: "public" } },
          { allowed_roles: { $in: [options.role] } },
          { allowed_user_ids: { $in: [options.userId] } },
        ],
      },
    ],
  };
  return vectorize.query(queryEmbedding, {
    topK: Math.max(1, Math.min(options.topK ?? 10, 100)),
    filter: filter as VectorizeVectorMetadataFilter,
    returnMetadata: "indexed",
  });
}
