import type { SpaceBlueprint } from "@naelao/agent-sdk";
import { describe, expect, it } from "vitest";
import worker from "./index.js";
import { mintInternalToken } from "@naelao/http";
import { previewBlueprintActivation } from "./blueprint-activation.js";
import { certifyStateDeltaArtifact } from "@naelao/security";

const blueprint = (
  overrides: Partial<SpaceBlueprint> = {}
): SpaceBlueprint => ({
  id: "tpl_test",
  schemaVersion: "2.0",
  metadata: { name: "Test" },
  templateCategory: "other",
  projects: [],
  requiredExtensions: ["ext_installed", "ext_supported", "ext_missing"],
  requiredCredentials: [
    { name: "Calendar", description: "Connect a calendar", required: true },
  ],
  ...overrides,
});

describe("Space Template activation preview", () => {
  it("does not imply declared project runtimes are installed when no host provisioner exists", () => {
    const project = { id: "project-a", name: "Project A", kind: "DualPane" as const, templateMode: "cowork_studio" as const,
      viewports: {}, systemPrompt: "", initialTasks: [], starterFiles: [], runtimeRequirements: [
        { id: "gpu", capabilities: ["cuda"], required: true, priority: 0, dependencies: [] },
        { id: "media", capabilities: ["ffmpeg"], required: false, priority: 1, dependencies: [] },
      ] };
    const preview = previewBlueprintActivation(blueprint({ projects: [project], requiredExtensions: [], requiredCredentials: [] }), new Map(), new Map());
    expect(preview).toMatchObject({ ready: false, runtime_requirements: [
      { project_id: "project-a", runtime_id: "gpu", required: true, status: "unavailable", reason: "runtime_provisioning_unavailable" },
      { project_id: "project-a", runtime_id: "media", required: false, status: "deferred", reason: "runtime_provisioning_unavailable" },
    ], blockers: ["required_runtime_unavailable:project-a:gpu"] });
  });

  it("rejects unauthenticated and non-admin preview requests before touching storage", async () => {
    const secret = "activation-preview-test-secret";
    const env = { PLATFORM_SECRET: secret } as never;
    const unauthenticated = await worker.fetch(new Request("https://spaces/spaces/space-a/blueprints/tpl-a/activation-preview", {
      headers: { "x-naelao-tenant-id": "tenant-a" },
    }), env, {} as ExecutionContext);
    expect(unauthenticated.status).toBe(403);
    const token = await mintInternalToken(secret, "tenant-a");
    const member = await worker.fetch(new Request("https://spaces/spaces/space-a/blueprints/tpl-a/activation-preview", {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a", "x-naelao-role": "member", "x-naelao-internal-token": token },
    }), env, {} as ExecutionContext);
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ error_code: "owner_or_admin_required" });
    const serviceOnly = await worker.fetch(new Request("https://spaces/spaces/space-a/blueprints/tpl-a/activate", {
      method: "POST", headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-role": "owner", "x-naelao-internal-token": token },
    }), env, {} as ExecutionContext);
    expect(serviceOnly.status).toBe(403);
    expect(await serviceOnly.json()).toMatchObject({ error_code: "human_activation_required" });
  });

  it("checks the target Space's active shared dependencies before activation and keeps preview read-only", async () => {
    const secret = "route-activation-secret";
    const artifact = blueprint({ projects: [], requiredExtensions: ["ext_required"], requiredCredentials: [] });
    const suite = { fixtures: Array.from({ length: 50 }, (_, index) => ({ id: `f-${index}` })) };
    const certificate = await certifyStateDeltaArtifact(artifact, suite, { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "tenant-a");
    if (!certificate) throw new Error("test_certificate_not_issued");
    const envelope = { blueprint: artifact, conformanceCertificate: certificate };
    const stored = new Map([[`blueprints/tenant-a/${artifact.id}.json`, envelope]]);
    let instantiateCalls = 0;
    const stub = { fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/extension-installations") return Response.json({ installations: [{ extension_id: "ext_required", scope: "PROJECT_BOUND", status: "active", release_version: "1.0.0", manifest_sha256: "a".repeat(64) }] });
      if (url.pathname === "/blueprints/instantiate") { instantiateCalls++; return Response.json({ projectIds: [], taskCount: 0, fileCount: 0 }, { status: 201 }); }
      return new Response("not found", { status: 404 });
    } };
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({ id: "space-a" }) }) }) };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db, SCRIPTS_R2: { get: async (key: string) => stored.has(key) ? { json: async () => stored.get(key) } : null },
      SPACE_DO: { idFromName: () => "space-do-id", get: () => stub } } as never;
    const headers = { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a", "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const preview = await worker.fetch(new Request(`https://spaces/spaces/space-a/blueprints/${artifact.id}/activation-preview`, { headers }), env, {} as ExecutionContext);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ ready: false, blockers: ["required_extension_unavailable:ext_required"], installs_or_grants_applied: false });
    envelope.conformanceCertificate = { ...certificate, signature: "stale" };
    const stale = await worker.fetch(new Request(`https://spaces/spaces/space-a/blueprints/${artifact.id}/activate`, { method: "POST", headers }), env, {} as ExecutionContext);
    expect(stale.status).toBe(422);
    expect(await stale.json()).toMatchObject({ error_code: "conformance_certificate_invalid" });
    envelope.conformanceCertificate = certificate;
    const blocked = await worker.fetch(new Request(`https://spaces/spaces/space-a/blueprints/${artifact.id}/activate`, { method: "POST", headers }), env, {} as ExecutionContext);
    expect(blocked.status).toBe(422);
    expect(instantiateCalls).toBe(0);
  });

  it("activates a certified template through the host for a fresh Space", async () => {
    const secret = "fresh-space-activation-secret";
    const artifact = blueprint({ id: "tpl_fresh_target", projects: [], requiredExtensions: [], requiredCredentials: [] });
    const suite = { fixtures: Array.from({ length: 50 }, (_, index) => ({ id: `fresh-${index}` })) };
    const certificate = await certifyStateDeltaArtifact(artifact, suite, { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "tenant-fresh");
    if (!certificate) throw new Error("test_certificate_not_issued");
    let activationCount = 0;
    const stub = { fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/extension-installations") return Response.json({ installations: [] });
      if (url.pathname === "/blueprints/instantiate") { activationCount++; return Response.json({ projectIds: [], taskCount: 0, fileCount: 0 }, { status: 201 }); }
      return new Response("not found", { status: 404 });
    } };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "fresh-space" }), run: async () => ({ success: true }) }) }) },
      SCRIPTS_R2: { get: async (key: string) => key === `blueprints/tenant-fresh/${artifact.id}.json` ? { json: async () => ({ blueprint: artifact, conformanceCertificate: certificate }) } : null },
      SPACE_DO: { idFromName: () => "fresh-space-do", get: () => stub } } as never;
    const headers = { "x-naelao-tenant-id": "tenant-fresh", "x-naelao-user-id": "owner", "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-fresh") };
    const preview = await worker.fetch(new Request(`https://spaces/spaces/fresh-space/blueprints/${artifact.id}/activation-preview`, { headers }), env, {} as ExecutionContext);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ ready: true, target_space_id: "fresh-space", requires_human_activation: true });
    const activation = await worker.fetch(new Request(`https://spaces/spaces/fresh-space/blueprints/${artifact.id}/activate`, { method: "POST", headers }), env, {} as ExecutionContext);
    expect(activation.status).toBe(201);
    expect(activationCount).toBe(1);
  });

  it("rejects a fork whose tenant license points at different certified bytes", async () => {
    const secret = "fork-license-test-secret";
    const artifact = blueprint({ id: "tpl_forked", projects: [], requiredExtensions: [], requiredCredentials: [] });
    const suite = { fixtures: Array.from({ length: 50 }, (_, index) => ({ id: `fork-${index}` })) };
    const certificate = await certifyStateDeltaArtifact(artifact, suite, { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "publisher-tenant");
    if (!certificate) throw new Error("test_certificate_not_issued");
    const db = { prepare: (query: string) => ({ bind: () => ({ first: async () => query.includes("FROM spaces") ? { id: "space-a" }
      : query.includes("marketplace_forks") ? { certificate_json: JSON.stringify(certificate), artifact_json: JSON.stringify({ ...artifact, metadata: { name: "tampered" } }) } : null }) }) };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db,
      SCRIPTS_R2: { get: async () => ({ json: async () => ({ blueprint: artifact, conformanceCertificate: certificate }) }) },
      SPACE_DO: { idFromName: () => "must-not-be-read", get: () => ({ fetch: async () => { throw new Error("unexpected_space_do_call"); } }) } } as never;
    const headers = { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const response = await worker.fetch(new Request(`https://spaces/spaces/space-a/blueprints/${artifact.id}/activation-preview`, { headers }), env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "template_license_mismatch" });
  });

  it("reports target dependency state and credential setup without installing or granting", () => {
    const result = previewBlueprintActivation(
      blueprint(),
      new Map([["ext_installed", { version: "1.0.0", digest: "a".repeat(64) }]]),
      new Map([["ext_supported", { version: "1.0.0", digest: "b".repeat(64) }]])
    );
    expect(result).toMatchObject({
      ready: false,
      requires_human_activation: true,
      installs_or_grants_applied: false,
      dependencies: [
        { extension_id: "ext_installed", status: "installed" },
        { extension_id: "ext_missing", status: "unavailable" },
        { extension_id: "ext_supported", status: "installable" },
      ],
      setup_credentials: [
        { name: "Calendar", description: "Connect a calendar", required: true },
      ],
      blockers: ["required_extension_unavailable:ext_missing"],
    });
  });

  it("deduplicates dependencies and is ready only when every dependency is present or installable", () => {
    const result = previewBlueprintActivation(
      blueprint({ requiredExtensions: ["ext_supported", "ext_supported"] }),
      new Map(),
      new Map([["ext_supported", { version: "1.0.0", digest: "b".repeat(64) }]])
    );
    expect(result.ready).toBe(true);
    expect(result.dependencies).toEqual([
      { extension_id: "ext_supported", status: "installable", available_version: "1.0.0", available_digest: "b".repeat(64) },
    ]);
    expect(result.blockers).toEqual([]);
  });

  it("blocks an installed release that does not match the immutable version pin", () => {
    const pinned = blueprint({ requiredExtensions: ["ext_installed"], requiredExtensionVersions: { ext_installed: "2.0.0" } });
    const result = previewBlueprintActivation(pinned, new Map([["ext_installed", { version: "1.0.0", digest: "a".repeat(64) }]]), new Map());
    expect(result.ready).toBe(false);
    expect(result.dependencies[0]).toMatchObject({ status: "version_mismatch", required_version: "2.0.0", available_version: "1.0.0" });
  });

  it("blocks content changes under the same package version", () => {
    const pinned = blueprint({ requiredExtensions: ["ext_supported"], requiredExtensionVersions: { ext_supported: "1.0.0" }, requiredExtensionDigests: { ext_supported: "a".repeat(64) } });
    const result = previewBlueprintActivation(pinned, new Map(), new Map([["ext_supported", { version: "1.0.0", digest: "b".repeat(64) }]]));
    expect(result.ready).toBe(false);
    expect(result.dependencies[0]).toMatchObject({ status: "version_mismatch", required_digest: "a".repeat(64), available_digest: "b".repeat(64) });
  });

  it("does not treat a paused dependency as ready for template activation", () => {
    const result = previewBlueprintActivation(blueprint({ requiredExtensions: ["ext_installed"] }),
      new Map([["ext_installed", { version: "1.0.0", digest: "a".repeat(64), status: "disabled" }]]), new Map());
    expect(result.ready).toBe(false);
    expect(result.dependencies[0]).toMatchObject({ extension_id: "ext_installed", status: "disabled" });
    expect(result.blockers).toEqual(["required_extension_disabled:ext_installed"]);
  });
});
