export interface ChannelSessionIdentity {
  spaceId: string;
  projectId?: string;
  channelType: string;
  conversationId: string;
  agentId: string;
}

/** Stable conversation identity that keeps each assistant's history isolated. */
export async function stableChannelSessionId(identity: ChannelSessionIdentity): Promise<string> {
  const value = new TextEncoder().encode([
    identity.spaceId,
    identity.projectId ?? "",
    identity.channelType,
    identity.conversationId,
    identity.agentId,
  ].join("\0"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return `channel-${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
