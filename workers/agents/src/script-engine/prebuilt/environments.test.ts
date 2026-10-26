import { describe, expect, it, vi } from "vitest";
import { environments } from "./environments.js";
import { ExecutionSessions, type SessionStorage } from "../../tunnels/execution-sessions.js";
import type { PrebuiltOpContext } from "./index.js";
function fixture() {
  const data = new Map<string, unknown>();
  let queue = Promise.resolve();
  const storage = { transaction: (fn: (tx: unknown) => Promise<unknown>) => {
    const operation = queue.then(() => fn({ get: async (key: string) => structuredClone(data.get(key)), put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); } }));
    queue = operation.then(() => undefined, () => undefined); return operation;
  } } as SessionStorage;
  const machine = { machineId: "gpu", updatedAt: Date.now(), hardware: { capabilities: ["cuda", "bash"], apps: [{ id: "blender" }] }, grants: [{ actorId: "owner", projectId: "project", expiresAt: Date.now() + 60000, commands: ["python train.py"], externalUse: ["capability"] }] };
  const ctx = { env: { tenantId: "tenant", spaceId: "space", projectId: "project", agentId: "agent", runId: "run", humanInvokerId: "owner", nativeExecutionAllowed: true, maxTier: 6,
    executionSessions: new ExecutionSessions(storage), scriptsBucket: {}, admitExternalEnvironment: vi.fn(async () => true),
    containerRuntimeInventory: vi.fn(async () => ({ installed: [{ installationId: "runtime", projectId: "project", contract: { image: "image", exportedBinaries: ["node"] } }], catalogue: [] })),
    codeRunner: { run: vi.fn(async () => ({ ok: true, output: { stdout: "built" }, tier: 6, actual_tier: 6, engine: "container" })) },
    localTunnel: { list: vi.fn(async () => [machine]), status: vi.fn(async () => ({ connected: true })), exec: vi.fn(async () => ({ ok: true, status: "sent", request_id: "request" })), requestStatus: vi.fn(async () => ({ ok: true, result: { status: "succeeded", stdout: "trained" } })) },
  }, authorizeShell: vi.fn(async () => true) } as unknown as PrebuiltOpContext;
  return { ctx, machine };
}
const execute = environments.operations["environment.execute"]!;
describe("environment tool host integration", () => {
  it("pins an installation and returns confirmed results without re-executing", async () => {
    const { ctx } = fixture(), args = { session_id: "build", action_id: "compile", command: "npm run build" };
    await execute(args, ctx); await execute(args, ctx);
    expect(ctx.env.codeRunner!.run).toHaveBeenCalledTimes(1);
    expect(ctx.env.codeRunner!.run).toHaveBeenCalledWith(expect.objectContaining({ installationId: "runtime", runId: "run", projectId: "project" }));
  });
  it("routes a consented exact command to a GPU and reconciles its receipt", async () => {
    const { ctx } = fixture(), args = { session_id: "gpujob", action_id: "train", command: "python train.py", capabilities: ["cuda"], mode: "capability" };
    expect(await execute(args, ctx)).toMatchObject({ status: "sent", environment_id: "gpu" });
    await expect(execute({ ...args, command: "python steal.py", action_id: "other" }, ctx)).rejects.toThrow();
    await environments.operations["environment.status"]!({ session_id: "gpujob", action_id: "train" }, ctx);
    expect(await execute(args, ctx)).toMatchObject({ status: "succeeded", stdout: "trained" });
    expect(ctx.env.localTunnel!.exec).toHaveBeenCalledTimes(1);
  });
  it("keeps a connected computer's filesystem local and binds cwd into the action identity", async () => {
    const { ctx } = fixture(), args = { session_id: "local", action_id: "edit", command: "python train.py", cwd: "/home/owner/project", capabilities: ["cuda"], mode: "capability" };
    await execute(args, ctx);
    expect(ctx.env.localTunnel!.exec).toHaveBeenCalledWith(expect.objectContaining({ params: { command: args.command, cwd: args.cwd } }));
    await expect(execute({ ...args, cwd: "/home/owner/other" }, ctx)).rejects.toThrow("environment_action_conflict");
    expect(ctx.env.containerRuntimeInventory).toHaveBeenCalled();
  });
  it("rejects caller-supplied fallback evidence and lower execution ceilings", async () => {
    const { ctx } = fixture(), args = { session_id: "session", action_id: "step", command: "python train.py", mode: "fallback", managedUnavailable: true };
    await expect(execute(args, ctx)).rejects.toThrow("host_availability_evidence");
    ctx.env.maxTier = 2;
    await expect(execute({ ...args, mode: "capability" }, ctx)).rejects.toThrow("native_execution_denied");
    expect(ctx.env.localTunnel!.exec).not.toHaveBeenCalled();
  });
  it("checks shell authorization even for a granted tunnel command", async () => {
    const { ctx } = fixture(); ctx.authorizeShell = async () => false;
    await expect(execute({ session_id: "session", action_id: "step", command: "python train.py", capabilities: ["cuda"], mode: "capability" }, ctx)).rejects.toThrow("shell_permission_denied");
    expect(ctx.env.localTunnel!.exec).not.toHaveBeenCalled();
  });
});
