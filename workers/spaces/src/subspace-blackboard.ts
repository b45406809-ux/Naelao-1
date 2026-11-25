export type SubspaceBlackboardKind =
  | "finding"
  | "artifact"
  | "question"
  | "blocker"
  | "risk"
  | "completion"
  | "verification";

export interface SubspaceBlackboardRoute {
  id: string;
  sourceSubspaceId: string;
  targetSubspaceId: string;
  allowedKinds: readonly SubspaceBlackboardKind[];
  allowReply: boolean;
  status: "active" | "revoked";
}

export interface SubspaceBlackboardMessage {
  id: string;
  routeId: string;
  sourceSubspaceId: string;
  targetSubspaceId: string;
  senderSubspaceId: string;
  senderId: string;
  kind: SubspaceBlackboardKind;
  text: string;
  createdAt: string;
  replyTo?: string;
  resource_ref?: SubspaceResourceRef;
}

export interface SubspaceResourceRef {
  type: "knowledge_document";
  target_space_id: string;
  document_id: string;
}

const resourceIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value);

/** Validates an untrusted reference and returns it in canonical key order, or null when invalid. Grants nothing. */
export function parseSubspaceResourceRef(value: unknown, kind: unknown): SubspaceResourceRef | null {
  if (kind !== "artifact" || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort().join(",");
  if (keys !== "document_id,target_space_id,type" || input.type !== "knowledge_document"
      || !resourceIdentifier(input.target_space_id) || !resourceIdentifier(input.document_id)) return null;
  return { type: "knowledge_document", target_space_id: input.target_space_id, document_id: input.document_id };
}

export const serializeSubspaceResourceRef = (ref: SubspaceResourceRef | undefined | null): string | null =>
  ref ? JSON.stringify({ type: ref.type, target_space_id: ref.target_space_id, document_id: ref.document_id }) : null;

/** Parses the stored column defensively; malformed storage yields no reference. */
export function readStoredSubspaceResourceRef(json: unknown): SubspaceResourceRef | undefined {
  if (typeof json !== "string") return undefined;
  try { return parseSubspaceResourceRef(JSON.parse(json), "artifact") ?? undefined; } catch { return undefined; }
}

const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const kinds = new Set<SubspaceBlackboardKind>([
  "finding", "artifact", "question", "blocker", "risk", "completion", "verification",
]);

export interface SubspaceHierarchyRow {
  id: string;
  parentId: string | null;
  depth: number;
  status: string;
}

/** The caller must load all three rows from the same parent SpaceDO. */
export function isImmediateActiveSiblingPair(
  parent: SubspaceHierarchyRow | null,
  source: SubspaceHierarchyRow | null,
  target: SubspaceHierarchyRow | null,
): boolean {
  return Boolean(parent && source && target && parent.status === "active" && parent.depth === 0
    && parent.parentId === null && source.id !== target.id && source.status === "active"
    && target.status === "active" && source.depth === 1 && target.depth === 1
    && source.parentId === parent.id && target.parentId === parent.id);
}

export function createSubspaceBlackboardMessage(input: {
  id: unknown;
  kind: unknown;
  text: unknown;
  replyTo?: unknown;
  resourceRef?: SubspaceResourceRef;
}, route: SubspaceBlackboardRoute, senderSubspaceId: string, senderId: string,
existing: readonly SubspaceBlackboardMessage[], now: string): SubspaceBlackboardMessage {
  if (route.status !== "active" || !identifier(route.id) || !identifier(route.sourceSubspaceId)
      || !identifier(route.targetSubspaceId) || route.sourceSubspaceId === route.targetSubspaceId)
    throw new Error("subspace_blackboard_route_unavailable");
  if (!identifier(input.id) || !identifier(senderId) || !identifier(senderSubspaceId)
      || !kinds.has(input.kind as SubspaceBlackboardKind) || !route.allowedKinds.includes(input.kind as SubspaceBlackboardKind)
      || typeof input.text !== "string" || !input.text.trim() || input.text.length > 4000
      || !Number.isFinite(Date.parse(now))) throw new Error("subspace_blackboard_message_invalid");

  const isSourceSend = senderSubspaceId === route.sourceSubspaceId && input.replyTo === undefined;
  const isTargetReply = senderSubspaceId === route.targetSubspaceId && route.allowReply
    && identifier(input.replyTo);
  if (!isSourceSend && !isTargetReply) throw new Error("subspace_blackboard_direction_denied");

  if (isTargetReply) {
    const original = existing.find(message => message.id === input.replyTo && message.routeId === route.id);
    if (!original || original.senderSubspaceId !== route.sourceSubspaceId
        || !["question", "blocker"].includes(original.kind)
        || original.createdAt > now
        || existing.some(message => message.replyTo === input.replyTo))
      throw new Error("subspace_blackboard_reply_scope_denied");
  }

  return {
    id: input.id,
    routeId: route.id,
    sourceSubspaceId: route.sourceSubspaceId,
    targetSubspaceId: route.targetSubspaceId,
    senderSubspaceId,
    senderId,
    kind: input.kind as SubspaceBlackboardKind,
    text: input.text,
    createdAt: now,
    ...(isTargetReply ? { replyTo: input.replyTo as string } : {}),
    ...(input.resourceRef ? { resource_ref: input.resourceRef } : {}),
  };
}

/** Each active route is visible only on its two participating subspace boards. */
export function visibleSubspaceBlackboardMessages(
  route: SubspaceBlackboardRoute,
  subspaceId: string,
  messages: readonly SubspaceBlackboardMessage[],
): SubspaceBlackboardMessage[] {
  if (route.status !== "active" || (subspaceId !== route.sourceSubspaceId && subspaceId !== route.targetSubspaceId))
    return [];
  return messages.filter(message => message.routeId === route.id
    && message.sourceSubspaceId === route.sourceSubspaceId
    && message.targetSubspaceId === route.targetSubspaceId)
    .map(message => ({ ...message }));
}
