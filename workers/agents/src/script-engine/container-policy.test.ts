import { describe, expect, it } from "vitest";
import { resolveContainerBinary, resolveContainerCapabilities, sidecarKey, validateContainerScope, type ContainerInvocationScope, type InstalledContainer } from "./container-policy.js";

const installation = (overrides: Partial<InstalledContainer> = {}): InstalledContainer => ({
  tenantId: "tenant", spaceId: "space", projectId: "project", installationId: "install-a", extensionId: "media_tools",
  contract: {
    schemaVersion: "1.0", kind: "container", id: "ocr_runtime", version: "1.0.0",
    permissions: [{ scope: "PROJECT_BOUND", actions: ["execute"], resource: "container" }],
    capabilityRequirements: ["native-execution"], lifecycle: {}, image: "registry.example/ocr@sha256:" + "a".repeat(64),
    resources: { memoryMb: 1024, cpuCores: 0.25, timeoutSeconds: 30 }, exportedBinaries: ["ocr", "pdf.ocr", "image.ocr"], networkPolicy: "none",
  }, scope: "PROJECT_BOUND", ...overrides,
});

describe("container capability resolution", () => {
  const owner = { tenantId: "tenant", spaceId: "space", projectId: "project", userId: "person" };

  it("resolves only an exact authorized installation satisfying every requested capability", () => {
    const selected = installation();
    expect(resolveContainerCapabilities(["pdf.ocr"], [selected], owner)).toBe(selected);
    expect(resolveContainerCapabilities(["pdf.ocr", "video.transcode"], [selected], owner)).toBeUndefined();
  });

  it("routes declared binaries through the same strict project and assistant scope checks", () => {
    const selected = installation();
    expect(resolveContainerBinary("ocr", [selected], owner)).toBe(selected);
    expect(resolveContainerBinary("ocr", [installation({ projectId: undefined })], owner)).toBeUndefined();
    expect(resolveContainerBinary("ocr", [installation({ scope: undefined })], owner)).toBeUndefined();
    expect(resolveContainerBinary("ocr", [installation({ scope: "SPACE_ASSISTANT", projectId: undefined })], owner)).toBeUndefined();
    expect(resolveContainerBinary("ocr", [installation({ scope: "SPACE_ASSISTANT", projectId: undefined })], { tenantId: "tenant", spaceId: "space", userId: "person" }))
      .toBeDefined();
  });

  it("does not cross project, space, assistant, or tenant scope", () => {
    expect(resolveContainerCapabilities(["pdf.ocr"], [installation({ projectId: "other" })], owner)).toBeUndefined();
    expect(resolveContainerCapabilities(["pdf.ocr"], [installation({ tenantId: "other" })], owner)).toBeUndefined();
    expect(resolveContainerCapabilities(["pdf.ocr"], [installation({ scope: "SPACE_ASSISTANT" })], owner)).toBeUndefined();
  });

  it("rejects ambiguous capability matches instead of choosing an arbitrary image", () => {
    expect(() => resolveContainerCapabilities(["pdf.ocr"], [installation(), installation({ installationId: "install-b" })], owner))
      .toThrow("container_capability_ambiguous");
  });

  it("rejects malformed requirements and leaves empty requirements unresolved", () => {
    expect(resolveContainerCapabilities([], [installation()], owner)).toBeUndefined();
    expect(() => resolveContainerCapabilities(["../escape"], [installation()], owner)).toThrow("container_capability_invalid");
  });

  it("accepts project-bound sidecar scope only when project identity is present", () => {
    const base = { tenantId: "tenant", spaceId: "space", actorId: "person", agentId: "worker", runId: "run", executionId: "exec",
      installationId: "install-a", installationScope: "PROJECT_BOUND" as const, image: "registry.example/ocr@sha256:" + "a".repeat(64), dynamicImage: true,
      timeoutMs: 30_000, deadline: Date.now() + 30_000 };
    expect(() => validateContainerScope({ ...base, projectId: "project" })).not.toThrow();
    expect(() => validateContainerScope(base)).toThrow("project_runtime_project_scope_required");
  });

  it("keeps an installed sidecar identity stable across worker runs but isolates one-off containers", () => {
    const base: ContainerInvocationScope = { tenantId: "tenant", spaceId: "space", projectId: "project", actorId: "person", agentId: "worker",
      runId: "run-one", executionId: "exec-one", installationId: "install-a", installationScope: "PROJECT_SHARED",
      image: "registry.example/ffmpeg@sha256:" + "b".repeat(64), timeoutMs: 30_000, deadline: Date.now() + 30_000 };
    const continuation = { ...base, runId: "run-two", executionId: "exec-two" };
    expect(sidecarKey(base)).toBe(sidecarKey(continuation));
    expect(sidecarKey({ ...base, installationId: undefined, installationScope: undefined })).not.toBe(
      sidecarKey({ ...continuation, installationId: undefined, installationScope: undefined }));
  });
});
