import { describe, expect, it, vi } from "vitest";
import { buildCodeRunner } from "./code-runner.js";

const image = "registry.cloudflare.com/" + "1".repeat(32) + "/native-tools@sha256:" + "a".repeat(64);
const installation = {
  tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", userId: "owner-a",
  installationId: "install-a", extensionId: "native-tools", scope: "PROJECT_SHARED" as const,
  contract: { id: "native-tools", image, resources: { memoryMb: 1024, cpuCores: .25, timeoutSeconds: 20 }, exportedBinaries: ["native-tool"] },
};

describe("Project extension execution routing", () => {
  it("uses the stable Project main runtime with exact image admission and no sidecar identity", async () => {
    let invocationScope: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (request: Request) => {
      invocationScope = JSON.parse(request.headers.get("x-naelao-container-scope") ?? "{}") as Record<string, unknown>;
      return Response.json({ ok: true, result: "project-runtime-ok" });
    });
    const idFromName = vi.fn((name: string) => name);
    const runner = buildCodeRunner({
      platformSecret: "project-extension-test-secret",
      authorizeContainer: async () => "space:3.project:7",
      resolveProjectRuntimeExtension: async () => installation,
      toolSandbox: { idFromName, get: () => ({ fetch }) } as never,
    });

    const result = await runner.run({ name: "container.extension_binary", code: "", args: { commands: "native-tool run" }, tier: 6, maxTier: 6,
      tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", userId: "owner-a", agentId: "assistant-a", runId: "run-a",
      projectRuntimeInstallationId: "install-a", projectRuntimeImage: image });

    expect(result).toMatchObject({ ok: true, output: "project-runtime-ok" });
    expect(idFromName).toHaveBeenCalledWith("sandbox:space-a:project-a");
    expect(invocationScope).toMatchObject({ projectId: "project-a", requiredCapabilities: ["extension.native_execute"], requiredImage: image,
      authorizationRevision: "space:3.project:7" });
    expect(invocationScope).not.toHaveProperty("installationId");
    expect(invocationScope).not.toHaveProperty("installationScope");
    expect(invocationScope).not.toHaveProperty("image");
    expect(invocationScope).not.toHaveProperty("dynamicImage");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fails closed when the host cannot resolve the active Project installation", async () => {
    const fetch = vi.fn();
    const runner = buildCodeRunner({
      authorizeContainer: async () => true,
      resolveProjectRuntimeExtension: async () => { throw new Error("project_extension_active_installation_required"); },
      toolSandbox: { idFromName: (name: string) => name, get: () => ({ fetch }) } as never,
    });
    const result = await runner.run({ name: "container.extension_binary", code: "", args: { commands: "native-tool run" }, tier: 6, maxTier: 6,
      tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", userId: "owner-a", agentId: "assistant-a", runId: "run-a",
      projectRuntimeInstallationId: "install-a" });

    expect(result).toMatchObject({ ok: false, error: "project_extension_active_installation_required" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not resolve or dispatch a Project extension after its current grant is revoked", async () => {
    const fetch = vi.fn();
    const idFromName = vi.fn((name: string) => name);
    const authorizeContainer = vi.fn(async () => false);
    const resolveProjectRuntimeExtension = vi.fn(async () => installation);
    const runner = buildCodeRunner({
      authorizeContainer,
      resolveProjectRuntimeExtension,
      toolSandbox: { idFromName, get: () => ({ fetch }) } as never,
    });
    const result = await runner.run({ name: "container.extension_binary", code: "", args: { commands: "native-tool run" }, tier: 6, maxTier: 6,
      tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", userId: "owner-a", agentId: "assistant-a", runId: "run-a",
      projectRuntimeInstallationId: "install-a", projectRuntimeImage: image });

    expect(result).toMatchObject({ ok: false, error: "container_execution_denied" });
    expect(authorizeContainer).toHaveBeenCalledOnce();
    expect(resolveProjectRuntimeExtension).not.toHaveBeenCalled();
    expect(idFromName).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a stale stored image pin for an otherwise active installation", async () => {
    const fetch = vi.fn();
    const runner = buildCodeRunner({ authorizeContainer: async () => true,
      resolveProjectRuntimeExtension: async () => installation,
      toolSandbox: { idFromName: (name: string) => name, get: () => ({ fetch }) } as never });
    const result = await runner.run({ name: "stored-script", code: "", args: {}, tier: 6, maxTier: 6,
      tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", userId: "owner-a", agentId: "assistant-a", runId: "run-a",
      projectRuntimeInstallationId: "install-a", projectRuntimeImage: "registry.cloudflare.com/" + "2".repeat(32) + "/old-image@sha256:" + "b".repeat(64) });

    expect(result).toMatchObject({ ok: false, error: "project_extension_image_installation_mismatch" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps explicitly selected user computers on the AgentPort path", async () => {
    const localMachine = vi.fn(async () => ({ ok: true, output: "external-ok", tier: 6, actual_tier: 6, engine: "container", duration_ms: 1, tokens_used: 0 }));
    const resolveProjectRuntimeExtension = vi.fn();
    const runner = buildCodeRunner({ authorizeContainer: async () => true, localMachine, resolveProjectRuntimeExtension });
    const result = await runner.run({ name: "container.extension_binary", code: "", args: { commands: "native-tool run" }, tier: 6, maxTier: 6,
      tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", userId: "owner-a", agentId: "assistant-a", runId: "run-a",
      projectRuntimeInstallationId: "install-a", containerOptions: { backend: "local_workstation", localMachineId: "machine-a" } });

    expect(result).toMatchObject({ ok: true, output: "external-ok" });
    expect(localMachine).toHaveBeenCalledOnce();
    expect(resolveProjectRuntimeExtension).not.toHaveBeenCalled();
  });

  it("does not fall back from failed managed shell or extension work to a local computer", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: false, error: "project_runtime_capability_unavailable" }, { status: 409 }));
    const idFromName = vi.fn((name: string) => name);
    const localMachine = vi.fn(async () => ({ ok: true, output: "must-not-run", tier: 6, actual_tier: 6,
      engine: "container", duration_ms: 1, tokens_used: 0 }));
    const runner = buildCodeRunner({ platformSecret: "project-extension-test-secret", authorizeContainer: async () => true,
      localMachine, resolveProjectRuntimeExtension: async () => installation,
      toolSandbox: { idFromName, get: () => ({ fetch }) } as never });
    const common = { tier: 6 as const, maxTier: 6, tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a",
      userId: "owner-a", agentId: "assistant-a", runId: "run-a" };

    const shell = await runner.run({ ...common, name: "Bash", code: "printf managed", args: { commands: "printf managed" } });
    const extension = await runner.run({ ...common, name: "container.extension_binary", code: "", args: { commands: "native-tool run" },
      projectRuntimeInstallationId: "install-a", projectRuntimeImage: image });

    expect(shell).toMatchObject({ ok: false, error: "project_runtime_capability_unavailable" });
    expect(extension).toMatchObject({ ok: false, error: "project_runtime_capability_unavailable" });
    expect(idFromName).toHaveBeenNthCalledWith(1, "sandbox:space-a:project-a");
    expect(idFromName).toHaveBeenNthCalledWith(2, "sandbox:space-a:project-a");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(localMachine).not.toHaveBeenCalled();
  });
});
