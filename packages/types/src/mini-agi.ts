export type MemberRole = "viewer" | "member" | "editor" | "admin" | "owner";

export const ROLE_HIERARCHY_RANK: Record<MemberRole, number> = {
  viewer: 1,
  member: 2,
  editor: 3,
  admin: 4,
  owner: 5
};

export interface ChunkVectorMetadata {
  space_id: string;
  project_id: string;       // Empty string "" indicates Space-wide knowledge
  min_role_rank: number;    // 1 to 5 (Minimum rank required to view)
  role_bitmask: number;     // Domain bitmask (e.g. 0x0001 = dev, 0x0010 = legal)
  doc_id: string;
  title: string;
  text: string;
  visibility: "public" | "private" | "role_restricted";
  allowed_user_ids?: string[]; // Optional user whitelist for hyper-confidential files
}

export interface PermissionedSearchQuery {
  queryVector: number[];
  spaceId: string;
  userRole: MemberRole;
  userBitmask?: number;
  activeProjectId?: string;
  topK?: number;
}

export interface SanitizedRetrievalResult {
  docId: string;
  chunkId: string;
  title: string;
  snippet: string;
  score: number;
  envelopedText: string;
}
