import type { RuntimeScope } from "@naelao/agent-sdk";

export * from "@naelao/agent-sdk";
export { defineChannelAdapter } from "./channel.js";
export type { ChannelAdapter, ChannelContract, ChannelOnlyExtensionContext, ChannelHandlerModule } from "./channel.js";

export interface SdkContext {
  readonly spaceId: string;
  readonly projectId?: string;
  readonly extensionId: string;
  readonly scope: RuntimeScope;
}

export function createSdkContext(input: SdkContext): SdkContext {
  if (!input.spaceId || !input.extensionId) throw new Error("sdk_context_identity_required");
  return Object.freeze({ ...input });
}
