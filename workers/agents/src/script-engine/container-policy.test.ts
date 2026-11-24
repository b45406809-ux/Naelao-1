import { describe, expect, it } from "vitest";
import { assertProjectRuntimeCapabilities, containerRuntimeResourceKey, containerWorkerConcurrency, parseApprovedContainerImages,
  resolveContainerBinary, resolveContainerCapabilities, sidecarKey, validateContainerScope,
  type ContainerInvocationScope, type InstalledContainer } from "./container-policy.js";

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

  it("keeps containers single-slot unless the opt-in contract and isolated branch are both present", () => {
    expect(containerWorkerConcurrency(installation(), true)).toBe(1);
    expect(containerWorkerConcurrency(installation({ contract: { ...installation().contract, parallelExecution: { isolation: "worker_branch", maxConcurrentWorkers: 3 } } }), false)).toBe(1);
    expect(containerWorkerConcurrency(installation({ contract: { ...installation().contract, parallelExecution: { isolation: "worker_branch", maxConcurrentWorkers: 3 } } }), true)).toBe(3);
  });

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

  it("assigns stable, scope-correct locks to selected container installations", async () => {
    const selected = resolveContainerCapabilities(["pdf.ocr"], [installation()], owner)!;
    const first = await containerRuntimeResourceKey(selected, owner.userId);
    expect(await containerRuntimeResourceKey(selected, owner.userId)).toBe(first);
    expect(first).toMatch(/^runtime\.project\.[a-f0-9]{40}$/);
    expect(await containerRuntimeResourceKey(installation({ installationId: "install-b" }), owner.userId)).not.toBe(first);
    expect(await containerRuntimeResourceKey(installation({ scope: "SPACE_SHARED", projectId: undefined }), owner.userId))
      .toMatch(/^runtime\.space\.[a-f0-9]{40}$/);
    expect(await containerRuntimeResourceKey(installation({ scope: "SPACE_USER", projectId: undefined, userId: "another-user" }), owner.userId))
      .not.toBe(await containerRuntimeResourceKey(installation({ scope: "SPACE_USER", projectId: undefined, userId: owner.userId }), owner.userId));
  });

  it("rejects malformed requirements and leaves empty requirements unresolved", () => {
    expect(resolveContainerCapabilities([], [installation()], owner)).toBeUndefined();
    expect(() => resolveContainerCapabilities(["../escape"], [installation()], owner)).toThrow("container_capability_invalid");
  });

  it("validates host-selected Project capabilities and returns only complete approved profiles", () => {
    const project: ContainerInvocationScope = { tenantId: "tenant", spaceId: "space", projectId: "project", actorId: "person",
      agentId: "worker", runId: "run", executionId: "exec", requiredCapabilities: ["media.audio_extract"],
      timeoutMs: 30_000, deadline: Date.now() + 30_000 };
    expect(() => validateContainerScope(project)).not.toThrow();
    expect(() => validateContainerScope({ ...project, requiredCapabilities: ["media.audio_extract", "media.audio_extract"] })).toThrow("project_runtime_capability_requirements_invalid");
    expect(() => validateContainerScope({ ...project, requiredCapabilities: ["native-execution"] as never })).toThrow("project_runtime_capability_requirements_invalid");
    const image = `registry.cloudflare.com/${"1".repeat(32)}/media-docs@sha256:${"a".repeat(64)}`;
    const pins = parseApprovedContainerImages(JSON.stringify([{ image, binding: "TOOL_SANDBOX", schedulingPolicy: "durable_object",
      networkPolicy: "none", cpuCores: .25, memoryMb: 1024,
      projectRuntime: { id: "media-documents", capabilities: ["media.audio_extract", "media.frame_extract", "document.pdf_render"] } }]));
    expect(pins[0]?.projectRuntime).toEqual({ id: "media-documents", capabilities: ["media.audio_extract", "media.frame_extract", "document.pdf_render"] });
    expect(() => parseApprovedContainerImages(JSON.stringify([{ image, binding: "TOOL_SANDBOX", schedulingPolicy: "durable_object",
      networkPolicy: "none", cpuCores: .25, memoryMb: 1024, projectRuntime: { id: "bad", capabilities: ["shell.root"] } }]))).toThrow("container_project_runtime_profile_invalid");
    expect(() => parseApprovedContainerImages(JSON.stringify([0, 1].map(index => ({ image: `registry.cloudflare.com/${"1".repeat(32)}/runtime-${index}@sha256:${String(index + 1).repeat(64)}`,
      binding: "TOOL_SANDBOX", schedulingPolicy: "durable_object", networkPolicy: "none", cpuCores: .25, memoryMb: 1024,
      projectRuntime: { id: "duplicate-profile", capabilities: ["media.audio_extract"] } }))))).toThrow("container_project_runtime_profile_invalid");
    let error: unknown;
    try { assertProjectRuntimeCapabilities(["media.audio_extract", "document.pdf_render"], [], [
      { id: "audio-only", capabilities: ["media.audio_extract"] },
      { id: "media-documents", capabilities: ["media.audio_extract", "document.pdf_render"] },
    ]); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ missingCapabilities: ["media.audio_extract", "document.pdf_render"], eligibleProfiles: ["media-documents"] });
  });

  it("accepts project-bound sidecar scope only when project identity is present", () => {
    const base = { tenantId: "tenant", spaceId: "space", actorId: "person", agentId: "worker", runId: "run", executionId: "exec",
      installationId: "install-a", installationScope: "PROJECT_BOUND" as const, image: "registry.example/ocr@sha256:" + "a".repeat(64), dynamicImage: true,
      timeoutMs: 30_000, deadline: Date.now() + 30_000 };
    expect(() => validateContainerScope({ ...base, projectId: "project" })).not.toThrow();
    expect(() => validateContainerScope(base)).toThrow("project_runtime_project_scope_required");
  });

  it("validates a worker revision and manifest hash as one authenticated pin", () => {
    const base: ContainerInvocationScope = { tenantId: "tenant", spaceId: "space", projectId: "project", actorId: "person", agentId: "worker",
      runId: "run", executionId: "exec", workspaceBranch: "workers/task-a", timeoutMs: 30_000, deadline: Date.now() + 30_000 };
    expect(() => validateContainerScope({ ...base, workspaceRevision: 4 })).toThrow("container_workspace_head_invalid");
    expect(() => validateContainerScope({ ...base, workspaceRevision: 4, workspaceManifestHash: "bad" })).toThrow("container_workspace_head_invalid");
    expect(() => validateContainerScope({ ...base, workspaceRevision: 4, workspaceManifestHash: "d".repeat(64) })).not.toThrow();
    expect(() => validateContainerScope({ ...base, authorizationRevision: "space:3.project:7" })).not.toThrow();
    expect(() => validateContainerScope({ ...base, authorizationRevision: "space:0.project:7" })).toThrow("container_authorization_revision_invalid");
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
