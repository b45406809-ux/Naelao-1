/**
 * Axis 5: Hierarchical Role-Based Access Control (RBAC) & Permissioned Vector Search
 *
 * Implements access bitmask evaluation and pre-filtered cosine similarity evaluation
 * across tenant/space hierarchies before score thresholding and context construction.
 */

import {
  escapeXml,
  maskInjectionPayload,
  scanForInjectionPatterns,
  createContextSandboxEnvelope,
} from "./firewall.js";

// Standard Authorization Bitmasks (16-bit / 32-bit bitfield)
export const ACL_BITMASK = {
  PUBLIC: 0x0001,       // 1 << 0: Accessible to anyone with space access
  DEV_READ: 0x0002,     // 1 << 1: Engineering documentation & technical specs
  DEV_WRITE: 0x0004,    // 1 << 2: Engineering codebase, internal keys, staging
  FINANCE: 0x0008,      // 1 << 3: Cap table, accounting, payroll, financial models
  LEGAL: 0x0010,        // 1 << 4: Delaware corporate filings, MSA, M&A term sheets
  EXEC: 0x0020,         // 1 << 5: Board decks, executive strategy, investor memos
  CONFIDENTIAL: 0x0040, // 1 << 6: Highly confidential / restricted proprietary secrets
  ADMIN: 0x0080,        // 1 << 7: Administrative space configurations & audit trails
  OWNER: 0x0100,        // 1 << 8: Complete unrestricted space ownership clearance
} as const;

export type AclBitmaskFlag = keyof typeof ACL_BITMASK;

export interface UserClearanceIdentity {
  userId: string;
  tenantId: string;
  spaceId: string;
  role: "owner" | "admin" | "editor" | "member" | "viewer" | string;
  department?: "engineering" | "legal" | "finance" | "executive" | "product" | string;
  clearanceFlags?: Array<AclBitmaskFlag | string>;
  customBitmask?: number;
}

export interface DocumentChunkRecord {
  id: string;
  docId: string;
  chunkIndex: number;
  content: string;
  tenantId: string;
  spaceId: string;
  projectId?: string | null;
  roleMask: number; // Stored authorization bitmask
  embedding?: number[];
  sourceUrl?: string;
  title?: string;
}

/**
 * Resolves an integer authorization bitmask for a user based on their role, department, and clearances.
 */
export function resolveUserBitmask(identity: UserClearanceIdentity): number {
  if (typeof identity.customBitmask === "number") {
    return identity.customBitmask;
  }

  let mask = ACL_BITMASK.PUBLIC;
  const role = identity.role.toLowerCase();

  if (role === "owner") {
    // Owner inherits all clearance flags
    return 0xffff;
  }

  if (role === "admin") {
    mask |= ACL_BITMASK.ADMIN | ACL_BITMASK.DEV_READ | ACL_BITMASK.DEV_WRITE | ACL_BITMASK.EXEC;
  } else if (role === "editor") {
    mask |= ACL_BITMASK.DEV_READ | ACL_BITMASK.DEV_WRITE;
  } else {
    mask |= ACL_BITMASK.PUBLIC;
  }

  // Departmental bitmask enhancements
  const dept = identity.department?.toLowerCase();
  if (dept === "engineering" || dept === "dev") {
    mask |= ACL_BITMASK.DEV_READ | ACL_BITMASK.DEV_WRITE;
  } else if (dept === "legal") {
    mask |= ACL_BITMASK.LEGAL | ACL_BITMASK.CONFIDENTIAL;
  } else if (dept === "finance") {
    mask |= ACL_BITMASK.FINANCE | ACL_BITMASK.CONFIDENTIAL;
  } else if (dept === "executive" || dept === "exec") {
    mask |= ACL_BITMASK.EXEC | ACL_BITMASK.FINANCE | ACL_BITMASK.LEGAL | ACL_BITMASK.CONFIDENTIAL;
  }

  // Explicit clearance flags
  if (identity.clearanceFlags) {
    for (const flag of identity.clearanceFlags) {
      const upper = flag.toUpperCase() as AclBitmaskFlag;
      if (upper in ACL_BITMASK) {
        mask |= ACL_BITMASK[upper];
      }
    }
  }

  return mask;
}

/**
 * Resolves the document bitmask to store during document chunk ingestion.
 */
export function resolveDocumentBitmask(
  visibility: "public" | "private" | "role_restricted" = "public",
  allowedRoles?: string[],
  department?: string
): number {
  if (visibility === "public") {
    return ACL_BITMASK.PUBLIC;
  }

  let mask = 0;
  if (allowedRoles) {
    for (const r of allowedRoles) {
      const lr = r.toLowerCase();
      if (lr === "owner") mask |= ACL_BITMASK.OWNER;
      if (lr === "admin") mask |= ACL_BITMASK.ADMIN | ACL_BITMASK.OWNER;
      if (lr === "editor" || lr === "dev" || lr === "developer") mask |= ACL_BITMASK.DEV_READ | ACL_BITMASK.DEV_WRITE;
      if (lr === "legal") mask |= ACL_BITMASK.LEGAL;
      if (lr === "finance") mask |= ACL_BITMASK.FINANCE;
      if (lr === "exec" || lr === "executive") mask |= ACL_BITMASK.EXEC;
      if (lr === "confidential") mask |= ACL_BITMASK.CONFIDENTIAL;
    }
  }

  if (department) {
    const d = department.toLowerCase();
    if (d === "legal") mask |= ACL_BITMASK.LEGAL;
    if (d === "finance") mask |= ACL_BITMASK.FINANCE;
    if (d === "engineering" || d === "dev") mask |= ACL_BITMASK.DEV_READ;
    if (d === "executive") mask |= ACL_BITMASK.EXEC;
  }

  return mask === 0 ? (ACL_BITMASK.ADMIN | ACL_BITMASK.OWNER) : mask;
}

/**
 * Checks if user bitmask overlaps with document authorization bitmask: (m_i & u) != 0
 */
export function hasBitmaskClearance(userMask: number, documentMask: number): boolean {
  return (userMask & documentMask) !== 0;
}

/**
 * Pre-filtered cosine similarity calculation.
 * Returns -Infinity if tenancy does not match or user lacks bitmask clearance.
 *
 * Sim(q, c_i) = (q . v_i / ||q|| ||v_i||) if (m_i & u) != 0 and Ten(c_i) == Ten(q) else -Infinity
 */
export function permissionedCosineSimilarity(
  qEmb: number[],
  docEmb: number[],
  userMask: number,
  docMask: number,
  userTenantId: string,
  docTenantId: string
): number {
  if (userTenantId !== docTenantId || !hasBitmaskClearance(userMask, docMask)) {
    return -Infinity;
  }

  if (qEmb.length !== docEmb.length || qEmb.length === 0) {
    return -Infinity;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < qEmb.length; i++) {
    const a = qEmb[i] ?? 0;
    const b = docEmb[i] ?? 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface PermissionedSearchResult {
  chunkId: string;
  docId: string;
  chunkIndex: number;
  content: string;
  similarityScore: number;
  safeContextEnvelope: string;
  roleMask: number;
}

/**
 * Algorithm 1: Permissioned Edge-Vector Search & Prompt Construction
 * Evaluates candidate chunks with ACL bitmask verification and dynamic prompt sanitization mapping.
 */
export function executePermissionedSearchAndContextBuild(
  queryEmbedding: number[],
  user: UserClearanceIdentity,
  candidates: DocumentChunkRecord[],
  topK: number = 8,
  minSimilarity: number = 0.65
): { results: PermissionedSearchResult[]; sanitizedContextBlock: string } {
  const userMask = resolveUserBitmask(user);
  const scoredChunks: Array<{ chunk: DocumentChunkRecord; score: number }> = [];

  for (const chunk of candidates) {
    // Exact space and tenant constraint
    if (chunk.tenantId !== user.tenantId || chunk.spaceId !== user.spaceId) {
      continue;
    }

    if (!hasBitmaskClearance(userMask, chunk.roleMask)) {
      continue; // Pre-filtered out before scoring / top-k accumulation
    }

    const score = chunk.embedding
      ? permissionedCosineSimilarity(queryEmbedding, chunk.embedding, userMask, chunk.roleMask, user.tenantId, chunk.tenantId)
      : 1.0;

    if (score >= minSimilarity) {
      scoredChunks.push({ chunk, score });
    }
  }

  // Sort descending by similarity score
  scoredChunks.sort((a, b) => b.score - a.score);
  const topCandidates = scoredChunks.slice(0, topK);

  const results: PermissionedSearchResult[] = [];
  const envelopes: string[] = [];

  for (const { chunk, score } of topCandidates) {
    const envelope = createContextSandboxEnvelope({
      id: chunk.id,
      content: chunk.content,
      access: "verified",
      source: chunk.sourceUrl ?? chunk.title,
      similarityScore: score,
    });

    results.push({
      chunkId: chunk.id,
      docId: chunk.docId,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      similarityScore: score,
      safeContextEnvelope: envelope,
      roleMask: chunk.roleMask,
    });

    envelopes.push(envelope);
  }

  return {
    results,
    sanitizedContextBlock: envelopes.join("\n\n"),
  };
}

// ── Mini-AGI 3-Tier Scoped Knowledge Base (Space, Project, Member Role) ────────

export const ROLE_HIERARCHY_RANK: Record<string, number> = {
  viewer: 1,
  member: 2,
  editor: 3,
  admin: 4,
  owner: 5,
};

export interface ChunkVectorMetadata {
  space_id: string;
  project_id: string; // "" = Space-wide, otherwise specific projectId
  min_role_rank: number; // e.g. 4 for Admin-only documents
  doc_id: string;
  chunk_index?: number;
  title: string;
  text: string;
  source_url?: string;
}

export function resolveRoleHierarchyRank(role?: string): number {
  if (!role) return 1;
  const lr = role.toLowerCase();
  return ROLE_HIERARCHY_RANK[lr] ?? 1;
}

export function resolveMinRoleRank(
  visibility: "public" | "private" | "role_restricted" = "public",
  allowedRoles?: string[]
): number {
  if (visibility === "public") return 1; // accessible to viewer (1)+
  if (!allowedRoles || allowedRoles.length === 0) return 4; // default admin

  let minRank = 5;
  for (const r of allowedRoles) {
    const rank = resolveRoleHierarchyRank(r);
    if (rank < minRank) {
      minRank = rank;
    }
  }
  return minRank;
}

/**
 * Builds the hardware-level Vectorize filter criteria to ensure zero data leakage across
 * Space, Project, and Member Role hierarchies.
 */
export function buildVectorizeAclFilter(
  spaceId: string,
  userRole: string,
  activeProjectId?: string
): Record<string, any> {
  const userRank = resolveRoleHierarchyRank(userRole);
  return {
    space_id: spaceId,
    project_id: { $in: [activeProjectId || "", ""] },
    min_role_rank: { $lte: userRank },
  };
}

export interface VectorizeLikeIndex {
  query: (
    vector: number[],
    options: {
      topK?: number;
      filter?: Record<string, any>;
      returnMetadata?: "all" | "indexed" | "none";
    }
  ) => Promise<{
    matches: Array<{
      id: string;
      score: number;
      metadata?: ChunkVectorMetadata | Record<string, any>;
    }>;
  }>;
}

/**
 * Executes a hardware-level permissioned knowledge retrieval query on Cloudflare Vectorize.
 * Enforces:
 * 1. space_id constraint
 * 2. Space-wide (project_id == "") OR activeProjectId
 * 3. min_role_rank <= userRank (Owner >= Admin >= Editor >= Member >= Viewer)
 */
export async function queryPermissionedKnowledge(
  vectorize: VectorizeLikeIndex,
  queryVector: number[],
  spaceId: string,
  userRole: string,
  activeProjectId?: string,
  topK = 6
): Promise<ChunkVectorMetadata[]> {
  const filter = buildVectorizeAclFilter(spaceId, userRole, activeProjectId);

  const matches = await vectorize.query(queryVector, {
    topK,
    filter,
    returnMetadata: "all",
  });

  return (matches.matches || []).map((m) => m.metadata as ChunkVectorMetadata).filter(Boolean);
}

