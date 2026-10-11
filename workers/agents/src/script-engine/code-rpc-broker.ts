import { WorkerEntrypoint } from "cloudflare:workers";
import { createScopedCodeRpc, type ScopedCodeRpcOptions } from "@naelao/agent-sdk";

const active = new Map<string, { call: (name: string, input: unknown) => Promise<unknown>; expires: number }>();
export interface CodeRpcBinding { call(name: string, input: unknown): Promise<unknown> }
export type CodeRpcFactory = (options: ScopedCodeRpcOptions) => Promise<{ binding: CodeRpcBinding; close(): void }>;

/** Loopback props carry only an opaque invocation ID. The host keeps authorization callbacks
 * and service bindings. A resumed/new parent isolate cannot use an old invocation registry. */
export function bindCodeRpc(factory: (input: { props: { invocationId: string } }) => CodeRpcBinding, options: ScopedCodeRpcOptions, deadline: number) {
  for (const [key, value] of active) if (value.expires <= Date.now()) active.delete(key);
  if (active.size >= 64) throw new Error("code_rpc_concurrency_limit");
  const invocationId = crypto.randomUUID();
  active.set(invocationId, { call: createScopedCodeRpc(options), expires: deadline });
  const close = () => { active.delete(invocationId); options.signal.removeEventListener("abort", close); };
  options.signal.addEventListener("abort", close, { once: true });
  if (options.signal.aborted) { close(); throw new Error("code_invocation_closed"); }
  try { return { binding: factory({ props: { invocationId } }), close }; }
  catch (error) { close(); throw error; }
}

export class CodeRpcBroker extends WorkerEntrypoint {
  async call(name: string, input: unknown): Promise<unknown> {
    const context = this.ctx as unknown as { props: { invocationId?: string } };
    const entry = active.get(context.props.invocationId ?? "");
    if (!entry || entry.expires <= Date.now()) throw new Error("code_invocation_closed");
    return entry.call(name, input);
  }
}
