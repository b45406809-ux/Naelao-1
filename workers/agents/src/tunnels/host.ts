import type { LocalTunnelDO } from "../do/LocalTunnelDO.js";
import { getDOName } from "@naelao/crypto";
import { assertMachineIdentity } from "@naelao/agent-sdk";
import type { NamedMachine } from "@naelao/agent-sdk";
import { mintInternalToken } from "@naelao/http";
import type { LocalTunnelGateway } from "../script-engine/types.js";
export async function namedTunnelStub(env: { PLATFORM_SECRET: string; LOCAL_TUNNEL?: DurableObjectNamespace<LocalTunnelDO> | undefined }, identity: { tenantId: string; spaceId: string; machineId: string }): Promise<DurableObjectStub<LocalTunnelDO>> {
  assertMachineIdentity(identity);
  if (!env.LOCAL_TUNNEL) throw new Error("tunnel_mesh_unavailable");
  const key = await getDOName("named-machine", identity.spaceId + ":" + identity.machineId, identity.tenantId, env.PLATFORM_SECRET);
  return env.LOCAL_TUNNEL.get(env.LOCAL_TUNNEL.idFromName(key));
}

/** The host supplies immutable actor/run scope. A command only selects a visible alias. */
export function createNamedTunnelGateway(
  env: { PLATFORM_SECRET: string; LOCAL_TUNNEL?: DurableObjectNamespace<LocalTunnelDO> | undefined; SPACES_WORKER: Fetcher },
  scope: { tenantId: string; spaceId: string; actorId: string; projectId?: string; runId: () => string | undefined; authorize: () => Promise<boolean>; authorizeDiscovery?: () => Promise<boolean> },
): LocalTunnelGateway {
  async function headers() {
    return { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId,
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, scope.tenantId), "x-naelao-user-id": scope.actorId };
  }
  async function list(): Promise<NamedMachine[]> {
    if (!scope.actorId || !await (scope.authorizeDiscovery ?? scope.authorize)()) throw new Error("tunnel_actor_grant_required");
    const response = await env.SPACES_WORKER.fetch(new Request("http://spaces-worker/spaces/" + encodeURIComponent(scope.spaceId) + "/tunnels", { headers: await headers() }));
    if (!response.ok) throw new Error("tunnel_registry_access_denied");
    const body = await response.json<{ machines: NamedMachine[] }>();
    return body.machines.filter(machine => machine.tenantId === scope.tenantId && machine.spaceId === scope.spaceId && machine.status === "active");
  }
  async function selected(alias: string) {
    if (!alias) throw new Error("named_machine_required");
    const matches = (await list()).filter(machine => machine.name === alias || machine.machineId === alias);
    if (matches.length !== 1) throw new Error("tunnel_named_machine_unavailable");
    const machine = matches[0]!;
    return { machine, stub: await namedTunnelStub(env, machine) };
  }
  async function call(machineName: string, path: string, op?: string, params?: Record<string, unknown>, requestId: string = crypto.randomUUID()) {
    if (!await scope.authorize()) throw new Error("tunnel_actor_grant_required");
    const runId = scope.runId();
    if (!runId) throw new Error("tunnel_run_scope_required");
    const { machine, stub } = await selected(machineName);
    const response = await stub.fetch(new Request("https://tunnel" + path, { method: "POST", headers: await headers(),
      body: JSON.stringify({ op, params, invocation: { actorId: scope.actorId, projectId: scope.projectId, runId, requestId, deadline: Date.now() + 60000 } }) }));
    const value = await response.json<{ ok: boolean; status?: string; request_id?: string; result?: unknown; error?: string }>();
    // A 202 is an accepted request with its durable ID, not a completed command.
    return { ...value, machine_id: machine.machineId, request_id: value.request_id ?? requestId };
  }
  return {
    list,
    exec: ({ machine, op, params, requestId }) => call(machine, "/exec", op, params, requestId),
    status: async machineName => {
      const { stub } = await selected(machineName);
      const response = await stub.fetch(new Request("https://tunnel/status", { headers: await headers() }));
      if (!response.ok) throw new Error("tunnel_status_unavailable");
      return response.json<{ connected: boolean }>();
    },
    requestStatus: (machine, requestId) => call(machine, "/request/status", undefined, undefined, requestId),
    cancel: (machine, requestId) => call(machine, "/cancel", undefined, undefined, requestId),
  };
}
