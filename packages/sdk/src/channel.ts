import type { ChannelContract } from "@naelao/agent-sdk";

export interface ChannelInboundEvent<T = unknown> { readonly name: string; readonly payload: T; readonly receivedAt: string; }
export interface ChannelOutboundEvent<T = unknown> { readonly name: string; readonly payload: T; }
export interface ChannelAdapter { readonly manifest: ChannelContract; receive(): Promise<readonly ChannelInboundEvent[]>; send(event: ChannelOutboundEvent): Promise<void>; }
export function defineChannelAdapter(adapter: ChannelAdapter): Readonly<ChannelAdapter> {
  if (!adapter?.manifest || typeof adapter.receive !== "function" || typeof adapter.send !== "function") throw new Error("invalid_channel_adapter");
  return Object.freeze(adapter);
}
