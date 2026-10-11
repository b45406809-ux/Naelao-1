/**
 * Named-machine operations. Registry membership and current machine grants are checked by
 * the host gateway and LocalTunnelDO, independently of the daemon's local consent.
 */
import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
function gateway(ctx: PrebuiltOpContext) {
  if (!ctx.env.localTunnel) throw new Error("tunnel_mesh_unavailable");
  return ctx.env.localTunnel;
}
async function dispatch(ctx: PrebuiltOpContext, args: Record<string, unknown>, op: string) {
  const machine = String(args.machine ?? "");
  if (!machine) throw new Error("named_machine_required");
  const params = op === "exec" ? { command: String(args.command ?? "") }
    : op === "read_file" ? { path: String(args.path ?? "") }
    : { path: String(args.path ?? ""), content: String(args.content ?? "") };
  const result = await gateway(ctx).exec({ machine, op, params, ...(args.request_id ? { requestId: String(args.request_id) } : {}) });
  if (!result.ok) throw new Error(result.error ?? ("tunnel_" + result.status + ": " + result.request_id));
  return result.status === "succeeded" ? result.result : result;
}
export const localMachine: PrebuiltScript = {
  name: "local-machine", domain: "container", requires_tier: 2,
  description: "Discover and explicitly select named private machines. Use naelao tunnel list, inspect <machine>, exec <machine> --command <exact command>, status <machine> --request-id <id>, cancel <machine> --request-id <id>. Pending is not success; indeterminate commands must never be automatically replayed.",
  operations: {
    "tunnel.list": async (_a, c) => ({ machines: await gateway(c).list() }),
    "tunnel.inspect": async (a, c) => {
      const machine = (await gateway(c).list()).find(m => m.name === a.machine || m.machineId === a.machine);
      if (!machine) throw new Error("tunnel_named_machine_unavailable");
      return { machine, ...(await gateway(c).status(machine.machineId)) };
    },
    "tunnel.exec": (a, c) => dispatch(c, a, "exec"),
    "tunnel.status": (a, c) => a.request_id ? gateway(c).requestStatus(String(a.machine ?? ""), String(a.request_id)) : gateway(c).status(String(a.machine ?? "")),
    "tunnel.cancel": (a, c) => gateway(c).cancel(String(a.machine ?? ""), String(a.request_id ?? "")),
    "local.read_file": (a, c) => dispatch(c, a, "read_file"),
    "local.write_file": (a, c) => dispatch(c, a, "write_file"),
    "local.exec": (a, c) => dispatch(c, a, "exec"),
    "local.status": async (_a, c) => ({ machines: await gateway(c).list() }),
  },
};
