export interface WsSessionMeta {
  tenantId: string;
  spaceId?: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
}

/** Restore durable socket identity after a Durable Object hibernation wake. */
export function restoreWsSessionMeta(
  attachment: WsSessionMeta | null | undefined,
  tags: readonly string[],
): WsSessionMeta | undefined {
  if (attachment) return attachment;
  const tenantTag = tags.find((tag) => tag.startsWith("tenantId:"));
  const spaceTag = tags.find((tag) => tag.startsWith("spaceId:"));
  if (!tenantTag && !spaceTag) return undefined;
  return {
    tenantId: tenantTag?.slice("tenantId:".length) ?? "",
    ...(spaceTag ? { spaceId: spaceTag.slice("spaceId:".length) } : {}),
  };
}
