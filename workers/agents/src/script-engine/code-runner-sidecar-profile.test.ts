import { describe, expect, it, vi } from "vitest";
import { buildCodeRunner } from "./code-runner.js";

describe("sidecar execution scope", () => {
  it("passes the server-resolved container ID and contract-bounded timeout to ToolSandboxDO", async () => {
    let scope: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (request: Request) => {
      scope = JSON.parse(request.headers.get("x-naelao-container-scope") ?? "{}") as Record<string, unknown>;
      return Response.json({ ok: true, result: "sidecar-ok" });
    });
    const runner = buildCodeRunner({
      platformSecret: "sidecar-test-secret",
      authorizeContainer: async () => true,
      resolveSidecar: async () => ({
        namespace: { idFromName: (name: string) => name, get: () => ({ fetch }) } as never,
        installation: {
          tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", userId: "owner-a", installationId: "install-a",
          extensionId: "tools", scope: "PROJECT_SHARED",
          contract: { id: "ffmpeg-runner", image: "registry.example/ffmpeg@sha256:" + "a".repeat(64), resources: { memoryMb: 2048, cpuCores: 1, timeoutSeconds: 30 }, exportedBinaries: ["ffmpeg"] },
        },
      }),
    });
    const result = await runner.run({
      name: "container.execute", code: "ffmpeg -version", args: {}, tier: 6, maxTier: 6,
      tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", userId: "owner-a", agentId: "assistant-a", runId: "run-a",
      containerImage: "registry.example/ffmpeg@sha256:" + "a".repeat(64), installationId: "install-a",
    } as never);
    expect(result).toMatchObject({ ok: true, output: "sidecar-ok" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(scope).toMatchObject({ installationId: "install-a", containerId: "ffmpeg-runner", timeoutMs: 30_000, image: expect.stringContaining("@sha256:") });
  });
});
