import { describe, expect, it, vi } from "vitest";
import { environments } from "./environments.js";
import { ExecutionSessions, type SessionStorage } from "../../tunnels/execution-sessions.js";
import { publishEnvironmentArtifactBytes } from "../environment-artifacts.js";
import { workspacePrefix } from "../types.js";
import type { PrebuiltOpContext } from "./index.js";
function fixture() {
  const data = new Map<string, unknown>();
  let queue = Promise.resolve();
  const storage = { transaction: (fn: (tx: unknown) => Promise<unknown>) => {
    const operation = queue.then(() => fn({ get: async (key: string) => structuredClone(data.get(key)), put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); } }));
    queue = operation.then(() => undefined, () => undefined); return operation;
  } } as SessionStorage;
  const machine = { machineId: "gpu", updatedAt: Date.now(), hardware: { capabilities: ["cuda", "bash"], apps: [{ id: "blender" }] }, grants: [{ actorId: "owner", projectId: "project" as string | undefined, expiresAt: Date.now() + 60000, commands: ["python train.py"], shellAccess: undefined as "sandboxed" | undefined, externalUse: ["capability"] }] };
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
  it("imports a small binary from the explicitly selected machine into scoped immutable storage", async () => {
    const { ctx } = fixture();
    const bytes = new Uint8Array([0, 255, 8, 13]);
    const objects = new Map<string, { bytes: Uint8Array; etag: string; customMetadata: Record<string, string> }>();
    ctx.env.scriptsBucket = {
      head: async (key: string) => { const value = objects.get(key); return value ? { ...value, size: value.bytes.length } : null; },
      get: async (key: string) => { const value = objects.get(key); return value ? { ...value, size: value.bytes.length, arrayBuffer: async () => value.bytes.slice().buffer } : null; },
      put: async (key: string, value: Uint8Array, options: { onlyIf?: { etagDoesNotMatch?: string }; customMetadata?: Record<string, string> }) => {
        if (options.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
        objects.set(key, { bytes: value, etag: "etag", customMetadata: options.customMetadata ?? {} }); return { etag: "etag" };
      },
    } as unknown as R2Bucket;
    ctx.env.localTunnel!.exec = vi.fn(async () => ({ ok: true, status: "succeeded", request_id: "read-1", result: { encoding: "base64", content: btoa("\0\u00ff\b\r"), bytes: bytes.length } }));
    const result = await environments.operations["environment.artifact_import"]!({ machine_id: "gpu", path: "/home/owner/data.bin" }, ctx);
    expect(result).toMatchObject({ bytes: bytes.length, immutable: true, machine_id: "gpu" });
    expect(ctx.env.localTunnel.exec).toHaveBeenCalledWith(expect.objectContaining({ machine: "gpu", op: "read_file", params: { path: "/home/owner/data.bin", encoding: "base64" } }));
    expect(objects.has(workspacePrefix(ctx.env) + ".environment-artifacts/" + (result as { digest: string }).digest)).toBe(true);
  });
  it("exports only a verified bounded artifact and asks the bridge to create a new local file", async () => {
    const { ctx } = fixture(), bytes = new Uint8Array([0, 255, 8, 13]);
    const objects = new Map<string, { bytes: Uint8Array; etag: string; customMetadata: Record<string, string> }>();
    ctx.env.scriptsBucket = {
      head: async (key: string) => { const value = objects.get(key); return value ? { ...value, size: value.bytes.length } : null; },
      get: async (key: string) => { const value = objects.get(key); return value ? { ...value, size: value.bytes.length, arrayBuffer: async () => value.bytes.slice().buffer } : null; },
      put: async (key: string, value: Uint8Array, options: { onlyIf?: { etagDoesNotMatch?: string }; customMetadata?: Record<string, string> }) => {
        if (options.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
        objects.set(key, { bytes: value, etag: "etag", customMetadata: options.customMetadata ?? {} }); return { etag: "etag" };
      },
    } as unknown as R2Bucket;
    const artifact = await publishEnvironmentArtifactBytes(ctx.env, bytes, "test");
    ctx.env.localTunnel!.exec = vi.fn(async () => ({ ok: true, status: "succeeded", request_id: "write-1", result: { written: true, bytes: bytes.length } }));
    expect(await environments.operations["environment.artifact_export"]!({ machine_id: "gpu", digest: artifact.digest, path: "/home/owner/new.bin" }, ctx)).toMatchObject({ exported: true, bytes: bytes.length });
    expect(ctx.env.localTunnel.exec).toHaveBeenCalledWith(expect.objectContaining({ machine: "gpu", op: "write_file", params: expect.objectContaining({ path: "/home/owner/new.bin", encoding: "base64", create_only: true }) }));
  });
  it("enforces the caller's read/write file role before machine transfers", async () => {
    const { ctx } = fixture();
    ctx.authorizeShell = vi.fn(async () => false);
    await expect(environments.operations["environment.artifact_import"]!({ machine_id: "gpu", path: "/home/owner/private.bin" }, ctx)).rejects.toThrow("environment_artifact_read_denied");
    expect(ctx.env.localTunnel!.exec).not.toHaveBeenCalled();
    await expect(environments.operations["environment.artifact_export"]!({ machine_id: "gpu", digest: "a".repeat(64), path: "/home/owner/new.bin" }, ctx)).rejects.toThrow("environment_artifact_write_denied");
    expect(ctx.env.localTunnel!.exec).not.toHaveBeenCalled();
  });
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
  it("selects a machine with a dual-approved sandboxed-shell grant", async () => {
    const { ctx, machine } = fixture();
    machine.grants[0]!.commands = [];
    machine.grants[0]!.shellAccess = "sandboxed";
    machine.grants[0]!.projectId = undefined;
    const result = await execute({ session_id: "local-shell", action_id: "list", command: "find . -maxdepth 1", capabilities: ["bash"], mode: "capability", target_id: "gpu" }, ctx);
    expect(result).toMatchObject({ status: "sent", environment_id: "gpu" });
    expect(ctx.env.localTunnel!.exec).toHaveBeenCalledTimes(1);
  });
  it("routes only to a connected machine with the requested fresh app profile", async () => {
    const { ctx, machine } = fixture();
    machine.hardware.apps = [{ id: "browser", connectionId: "profile-a", authenticatedAt: Date.now() }];
    const args = { session_id: "browser-session", action_id: "open", command: "python train.py", capabilities: ["cuda"], mode: "capability", target_id: "gpu", app_id: "browser", connection_id: "profile-a" };
    expect(await execute(args, ctx)).toMatchObject({ environment_id: "gpu" });
    await expect(execute({ ...args, action_id: "wrong-app", app_id: "office" }, ctx)).rejects.toThrow("environment_session_target_unavailable");
    expect(ctx.env.localTunnel!.exec).toHaveBeenCalledTimes(1);
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
