import {
  type KnowledgeCallerClaims,
  type KnowledgeClearance,
  resolveKnowledgeClearance as resolveClearance,
} from "@naelao/security";

/** Knowledge-worker entry point for sovereign permission resolution. */
export function resolveKnowledgeClearance(
  callerClaims: KnowledgeCallerClaims,
  spaceId: string,
  projectId?: string
): KnowledgeClearance {
  return resolveClearance(callerClaims, spaceId, projectId);
}
