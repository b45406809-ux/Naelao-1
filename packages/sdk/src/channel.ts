import { parseExtensionPrimitive, type ChannelContract, type ChannelOnlyExtensionContext } from "@naelao/agent-sdk";

/** The verified provider adapter belongs to Naelao's host, not to an installed extension. */
export type ChannelAdapter = ChannelContract;

/**
 * Type for the `export async function run(args, ctx)` entrypoint referenced by
 * `ChannelContract.handlerScript`. The host constructs this context after validating the
 * provider webhook and installation binding. It does not contain credentials, member identity,
 * project APIs, or arbitrary tools.
 */
export interface ChannelHandlerModule {
  run(args: Readonly<Record<string, unknown>>, ctx: ChannelOnlyExtensionContext): unknown | Promise<unknown>;
}

/**
 * Validate and freeze a declarative channel contract. This does not connect to a provider,
 * register a webhook, or expose OAuth tokens; those are host-managed connection operations.
 */
export function defineChannelAdapter(value: ChannelContract): Readonly<ChannelContract> {
  return Object.freeze(parseExtensionPrimitive(value) as ChannelContract);
}

export type { ChannelContract, ChannelOnlyExtensionContext };
