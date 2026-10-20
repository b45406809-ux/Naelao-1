import { describe, expect, it, vi } from "vitest";
import { createNamedTunnelGateway } from "./host.js";
import type { NamedMachine } from "@naelao/agent-sdk";

function fixture() {
  const identity = { tenantId: "tenant-1", spaceId: "space-1", machineId: "machine-1" };
  const machine = {
    schema: 1, ...identity, name: "workstation", ownerId: "actor-1", status: "active", sequence: 4, keyVersion: 2,
    hardware: { platform: "linux", arch: "x64", cpuCount: 4, memoryBytes: 8192, capabilities: [], models: ["local-model"] },
    grants: [],
  } as NamedMachine;
  const calls: Request[] = [];
  const response = vi.fn(async (request: Request) => {
    calls.push(request);
    if (new URL(request.url).pathname.endsWith("/tunnels")) return Response.json({ machines: [
      machine,
      { ...machine, machineId: "other-tenant-machine", tenantId: "other-tenant" },
      { ...machine, machineId: "revoked", status: "revoked" },
    ] });
    if (new URL(request.url).pathname === "/exec") return Response.json({ ok: true, status: "sent", request_id: "request-1" }, { status: 202 });
    return Response.json({ connected: true });
  });
  const stub = { fetch: response };
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => stub),
  };
  const env = { PLATFORM_SECRET: "test-secret", LOCAL_TUNNEL: namespace as never, SPACES_WORKER: { fetch: response } as never };
  const gateway = createNamedTunnelGateway(env, {
    tenantId: identity.tenantId, spaceId: identity.spaceId, actorId: "actor-1", projectId: "project-1",
    runId: () => "run-1", authorize: async () => true,
  });
  return { gateway, machine, calls, response, namespace };
}

describe("named tunnel host gateway", () => {
  it("requires current host authorization and filters registry entries to the active tenant and Space", async () => {
    const f = fixture();
    expect(await f.gateway.list()).toEqual([f.machine]);
    const denied = createNamedTunnelGateway({ ...({ PLATFORM_SECRET: "test-secret", SPACES_WORKER: { fetch: vi.fn() } } as never) }, {
      tenantId: "tenant-1", spaceId: "space-1", actorId: "actor-1", runId: () => "run-1", authorize: async () => false,
    });
    await expect(denied.list()).rejects.toThrow("tunnel_actor_grant_required");
  });

  it("pins the actor, project, run, and machine identity when dispatching an operation", async () => {
    const f = fixture();
    const result = await f.gateway.exec({ machine: "workstation", op: "exec", params: { command: "test" }, requestId: "request-1" });
    expect(result).toMatchObject({ ok: true, status: "sent", machine_id: "machine-1", request_id: "request-1" });
    const exec = f.calls.find((request) => new URL(request.url).pathname === "/exec")!;
    const body = await exec.json() as { invocation: Record<string, unknown>; params: Record<string, unknown> };
    expect(body.invocation).toMatchObject({ actorId: "actor-1", projectId: "project-1", runId: "run-1", requestId: "request-1" });
    expect(body.params).toEqual({ command: "test" });
    expect(exec.headers.get("x-naelao-internal-token")).toBeTruthy();
  });

  it("fails closed for missing or ambiguous visible machine aliases", async () => {
    const f = fixture();
    await expect(f.gateway.exec({ machine: "missing", op: "exec", params: {} })).rejects.toThrow("tunnel_named_machine_unavailable");
    const duplicate = { ...f.machine, machineId: "machine-duplicate" } as NamedMachine;
    const ambiguous = createNamedTunnelGateway({
      PLATFORM_SECRET: "test-secret", SPACES_WORKER: { fetch: async () => Response.json({ machines: [f.machine, duplicate] }) } as never,
    }, { tenantId: "tenant-1", spaceId: "space-1", actorId: "actor-1", runId: () => "run-1", authorize: async () => true });
    await expect(ambiguous.status("workstation")).rejects.toThrow("tunnel_named_machine_unavailable");
  });
});
