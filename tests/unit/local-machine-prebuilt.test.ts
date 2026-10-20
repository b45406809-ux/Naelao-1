import { describe, it, expect, vi } from "vitest";
import { localMachine } from "../../workers/agents/src/script-engine/prebuilt/local-machine.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

const noopRun = async () => ({});
const machine = { machineId: "machine-1", tenantId: "tenant-1", spaceId: "space-1", name: "build-host", status: "active" } as const;

function makeContext(options: {
  result?: { ok: boolean; status?: string; request_id?: string; result?: unknown; error?: string };
  machines?: typeof machine[];
  configured?: boolean;
} = {}) {
  const exec = vi.fn(async () => options.result ?? { ok: true, status: "succeeded", result: "done" });
  const list = vi.fn(async () => options.machines ?? [machine]);
  const status = vi.fn(async () => ({ connected: true }));
  const requestStatus = vi.fn(async () => ({ status: "succeeded", result: "done" }));
  const cancel = vi.fn(async () => ({ status: "cancelled" }));
  const ctx = {
    env: { localTunnel: options.configured === false ? undefined : { exec, list, status, requestStatus, cancel } } as unknown as ScriptEngineEnv,
    run: noopRun,
  };
  return { ctx, exec, list, status, requestStatus, cancel };
}

describe("local-machine prebuilt — named machine gateway contract", () => {
  it("fails closed when the host has not configured the tunnel gateway", async () => {
    const { ctx } = makeContext({ configured: false });
    await expect(localMachine.operations["tunnel.list"]!({}, ctx)).rejects.toThrow("tunnel_mesh_unavailable");
    await expect(localMachine.operations["local.exec"]!({ machine: "build-host", command: "npm test" }, ctx)).rejects.toThrow("tunnel_mesh_unavailable");
  });

  it("requires an explicitly named machine before dispatch", async () => {
    const { ctx, exec } = makeContext();
    await expect(localMachine.operations["local.read_file"]!({ path: "/workspace/README.md" }, ctx)).rejects.toThrow("named_machine_required");
    expect(exec).not.toHaveBeenCalled();
  });

  it("forwards the machine alias and exact read parameters through the host gateway", async () => {
    const { ctx, exec } = makeContext();
    await expect(localMachine.operations["local.read_file"]!({ machine: "build-host", path: "/workspace/README.md" }, ctx)).resolves.toBe("done");
    expect(exec).toHaveBeenCalledWith({ machine: "build-host", op: "read_file", params: { path: "/workspace/README.md" } });
  });

  it("forwards write content without changing the selected machine", async () => {
    const { ctx, exec } = makeContext();
    await localMachine.operations["local.write_file"]!({ machine: "machine-1", path: "/workspace/out.txt", content: "hello" }, ctx);
    expect(exec).toHaveBeenCalledWith({ machine: "machine-1", op: "write_file", params: { path: "/workspace/out.txt", content: "hello" } });
  });

  it("passes command text unchanged to the host gateway", async () => {
    const { ctx, exec } = makeContext();
    const command = "npm test && printf done";
    await localMachine.operations["local.exec"]!({ machine: "build-host", command }, ctx);
    expect(exec).toHaveBeenCalledWith({ machine: "build-host", op: "exec", params: { command } });
  });

  it("forwards an explicit idempotency request id", async () => {
    const { ctx, exec } = makeContext({ result: { ok: true, status: "accepted", request_id: "req-1" } });
    const result = await localMachine.operations["tunnel.exec"]!({ machine: "build-host", command: "npm test", request_id: "req-1" }, ctx);
    expect(exec).toHaveBeenCalledWith({ machine: "build-host", op: "exec", params: { command: "npm test" }, requestId: "req-1" });
    expect(result).toMatchObject({ status: "accepted", request_id: "req-1" });
  });

  it("returns a pending receipt intact rather than calling it a completed result", async () => {
    const receipt = { ok: true, status: "accepted", request_id: "req-pending" };
    const { ctx } = makeContext({ result: receipt });
    await expect(localMachine.operations["local.exec"]!({ machine: "build-host", command: "long task" }, ctx)).resolves.toEqual(receipt);
  });

  it("surfaces gateway failures", async () => {
    const { ctx } = makeContext({ result: { ok: false, status: "denied", request_id: "req-2", error: "machine_grant_required" } });
    await expect(localMachine.operations["local.exec"]!({ machine: "build-host", command: "npm test" }, ctx)).rejects.toThrow("machine_grant_required");
  });

  it("lists only the machine inventory supplied by the host-authorized gateway", async () => {
    const { ctx, list } = makeContext();
    await expect(localMachine.operations["tunnel.list"]!({}, ctx)).resolves.toEqual({ machines: [machine] });
    expect(list).toHaveBeenCalledOnce();
  });

  it("inspects a selected machine by stable id and includes connection status", async () => {
    const { ctx, list, status } = makeContext();
    await expect(localMachine.operations["tunnel.inspect"]!({ machine: "build-host" }, ctx)).resolves.toEqual({ machine, connected: true });
    expect(status).toHaveBeenCalledWith("machine-1");
    expect(list).toHaveBeenCalledOnce();
  });

  it("does not inspect a name outside the authorized machine inventory", async () => {
    const { ctx, status } = makeContext({ machines: [] });
    await expect(localMachine.operations["tunnel.inspect"]!({ machine: "unknown" }, ctx)).rejects.toThrow("tunnel_named_machine_unavailable");
    expect(status).not.toHaveBeenCalled();
  });

  it("supports machine status, durable request status, and cancellation", async () => {
    const { ctx, status, requestStatus, cancel } = makeContext();
    await expect(localMachine.operations["tunnel.status"]!({ machine: "build-host" }, ctx)).resolves.toEqual({ connected: true });
    await expect(localMachine.operations["tunnel.status"]!({ machine: "build-host", request_id: "req-3" }, ctx)).resolves.toEqual({ status: "succeeded", result: "done" });
    await expect(localMachine.operations["tunnel.cancel"]!({ machine: "build-host", request_id: "req-3" }, ctx)).resolves.toEqual({ status: "cancelled" });
    expect(status).toHaveBeenCalledWith("build-host");
    expect(requestStatus).toHaveBeenCalledWith("build-host", "req-3");
    expect(cancel).toHaveBeenCalledWith("build-host", "req-3");
  });

  it("reports the current inventory from local.status", async () => {
    const { ctx } = makeContext();
    await expect(localMachine.operations["local.status"]!({}, ctx)).resolves.toEqual({ machines: [machine] });
  });
});
