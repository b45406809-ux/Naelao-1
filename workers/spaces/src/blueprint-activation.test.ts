import { validateBlueprintSetupSchema, type SpaceBlueprint } from "@naelao/agent-sdk";
import { describe, expect, it } from "vitest";
import worker, { blueprintRuntimeInstallability } from "./index.js";
import { mintInternalToken, verifyInternalToken } from "@naelao/http";
import { previewBlueprintActivation } from "./blueprint-activation.js";
import { certifyStateDeltaArtifact } from "@naelao/security";

const blueprint = (overrides: Partial<SpaceBlueprint> = {}): SpaceBlueprint => {
  const requiredExtensions = overrides.requiredExtensions ?? ["ext_installed", "ext_supported", "ext_missing"];
  return {
    id: "tpl_test",
    schemaVersion: "2.0",
    metadata: { name: "Test" },
    templateCategory: "other",
    projects: [],
    requiredExtensions,
    requiredExtensionVersions: Object.fromEntries(requiredExtensions.map((id) => [id, "1.0.0"])),
    requiredCredentials: [
      { name: "Calendar", description: "Connect a calendar", required: true },
    ],
    ...overrides,
  };
};

describe("Space Template activation preview", () => {
  it("checks signed knowledge and action requirements against the exact trusted dependency declaration", () => {
    const artifact = blueprint({ requiredExtensions: ["ext_support"], requiredCredentials: [], extensionRequirements: {
      knowledge: [{ extensionId: "ext_support", knowledgeId: "public_faq", purpose: "Answer approved questions", access: "owner_published_external", required: true }],
      actions: [{ extensionId: "ext_support", primitiveId: "booking", scope: "PROJECT_BOUND", resource: "calendar.events", action: "execute", purpose: "Book approved appointments", required: true }],
    } });
    const summary = { knowledge: [{ id: "public_faq", purpose: "Published FAQ answers", access: "owner_published_external" }],
      primitives: [{ id: "booking", permission_grants: [{ scope: "PROJECT_BOUND", resource: "calendar.events", action: "execute" }] }] } as never;
    const ready = previewBlueprintActivation(artifact, new Map([["ext_support", { version: "1.0.0", digest: "a".repeat(64), status: "active", summary }]]), new Map());
    expect(ready).toMatchObject({ ready: true, extension_requirements: {
      knowledge: [{ knowledge_id: "public_faq", status: "available", package_purpose: "Published FAQ answers" }],
      actions: [{ primitive_id: "booking", status: "available" }],
    } });
    const missing = previewBlueprintActivation(artifact, new Map([["ext_support", { version: "1.0.0", digest: "a".repeat(64), status: "active", summary: { knowledge: [], primitives: [] } as never }]]), new Map());
    expect(missing).toMatchObject({ ready: false, blockers: [
      "required_blueprint_knowledge_unavailable:ext_support:public_faq",
      "required_blueprint_action_unavailable:ext_support:booking:execute",
    ] });
  });

  it("exposes a signed coordination suggestion without applying it", () => {
    const preview = previewBlueprintActivation(blueprint({ requiredExtensions: [], requiredCredentials: [],
      coordinationDefaults: { memberFactsEnabled: true } }), new Map(), new Map());
    expect(preview.coordination_defaults).toEqual({ memberFactsEnabled: true });
    expect(preview).toMatchObject({ requires_human_activation: true, installs_or_grants_applied: false });
  });

  it("previews validated channel availability without exposing account provisioning directives", () => {
    const preview = previewBlueprintActivation(blueprint({ requiredExtensions: [], requiredCredentials: [], assistantChannels: {
      spaceAssistant: { enabled: { chat: true, phone: false }, phonePrompt: "recommended" },
      emailProvisioning: { spaceAssistant: { provider: "agentmail", defaultMode: "naelao_managed", provisionOnCreate: true } },
    } }), new Map(), new Map());
    expect(preview.assistant_channel_defaults).toEqual({
      spaceAssistant: { enabled: { chat: true, phone: false }, phonePrompt: "recommended" },
    });
    expect(preview.assistant_channel_defaults).not.toHaveProperty("emailProvisioning");
  });

  it("does not imply declared project runtimes are installed when no host provisioner exists", () => {
    const project = { id: "project-a", name: "Project A", kind: "DualPane" as const, templateMode: "cowork_studio" as const,
      viewports: {}, systemPrompt: "", initialTasks: [], starterFiles: [], runtimeRequirements: [
        { id: "gpu", capabilities: ["cuda"], required: true, priority: 0, dependencies: [] },
        { id: "media", capabilities: ["ffmpeg"], required: false, priority: 1, dependencies: [] },
      ] };
    const preview = previewBlueprintActivation(blueprint({ projects: [project], requiredExtensions: [], requiredCredentials: [] }), new Map(), new Map());
    expect(preview).toMatchObject({ ready: false, runtime_requirements: [
      { project_id: "project-a", runtime_id: "gpu", required: true, status: "unavailable", reason: "runtime_provisioning_unavailable" },
      { project_id: "project-a", runtime_id: "media", required: false, status: "deferred", reason: "optional_runtime_omitted" },
    ], blockers: ["required_runtime_unavailable:project-a:gpu"] });
  });

  it("allows only deployment and plan approved required runtimes through after human approval", () => {
    const project = { id: "project-a", name: "Project A", kind: "DualPane" as const, templateMode: "cowork_studio" as const,
      configuration: { executionCeiling: 6 }, viewports: {}, systemPrompt: "", initialTasks: [], starterFiles: [], runtimeRequirements: [
        { id: "ffmpeg", capabilities: ["ffmpeg"], required: true, priority: 0, dependencies: [] },
      ] };
    const artifact = blueprint({ projects: [project], requiredExtensions: [], requiredCredentials: [] });
    const ready = previewBlueprintActivation(artifact, new Map(), new Map(), new Map([["project-a:ffmpeg", { installable: true }]]));
    expect(ready).toMatchObject({ ready: true, runtime_requirements: [{ status: "installable", reason: "owner_approval_required" }], installs_or_grants_applied: false });
    const blocked = previewBlueprintActivation(artifact, new Map(), new Map(), new Map([["project-a:ffmpeg", { installable: false, reason: "subscription_resource_limit" }]]));
    expect(blocked).toMatchObject({ ready: false, blockers: ["required_runtime_unavailable:project-a:ffmpeg"], runtime_requirements: [{ status: "unavailable", reason: "subscription_resource_limit" }] });
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

  it("exposes only the Space Template installation receipt to its owner or administrator", async () => {
    const secret = "template-installation-status-secret";
    const stub = { fetch: async (request: Request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/blueprint-installations");
      expect(url.searchParams.get("tenant_id")).toBe("tenant-status");
      expect(url.searchParams.get("space_id")).toBe("space-status");
      expect(await verifyInternalToken(request.headers.get("x-naelao-internal-token"), "tenant-status", secret)).toBe(true);
      return Response.json({ installations: [{ blueprint_id: "tpl-status", artifact_sha256: "a".repeat(64), listing_id: "listing-status",
        setup_schema_version: 2, setup_revision: 3, required_extension_ids: ["ext_support"], project_ids: ["project-a"], status: "installed",
        error_code: null, created_at: "2026-11-13T00:00:00.000Z", updated_at: "2026-11-13T00:01:00.000Z" }] });
    } };
    const env = { PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "space-status" }), all: async () => ({ results: [] }) }) }) },
      SPACE_DO: { idFromName: () => "space-status-do", get: () => stub } } as never;
    const headers = { "x-naelao-tenant-id": "tenant-status", "x-naelao-user-id": "owner-status", "x-naelao-role": "owner",
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant-status") };
    const response = await worker.fetch(new Request("https://spaces/spaces/space-status/blueprints/installations", { headers }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ installations: [{ blueprint_id: "tpl-status", listing_id: "listing-status", setup_schema_version: 2 }] });
    const member = await worker.fetch(new Request("https://spaces/spaces/space-status/blueprints/installations", {
      headers: { ...headers, "x-naelao-role": "member" },
    }), env, {} as ExecutionContext);
    expect(member.status).toBe(403);
  });

  it("checks for a newer signed listing from the same publisher without applying it", async () => {
    const secret = "template-source-update-status-secret";
    const installed = blueprint({ id: "tpl_update", metadata: { name: "Installed support" }, setupSchemaVersion: 1,
      requiredExtensions: ["ext_old"], requiredExtensionVersions: { ext_old: "1.0.0" }, requiredCredentials: [] });
    const candidate = blueprint({ id: "tpl_update", metadata: { name: "Updated support" }, setupSchemaVersion: 2,
      requiredExtensions: ["ext_old", "ext_new"], requiredExtensionVersions: { ext_old: "2.0.0", ext_new: "1.0.0" }, requiredCredentials: [] });
    const suite = { fixtures: Array.from({ length: 50 }, (_, index) => ({ id: `source-${index}` })) };
    const certificate = await certifyStateDeltaArtifact(candidate, suite, {
      runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0,
      tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [],
    }, secret, "publisher-tenant");
    if (!certificate) throw new Error("template_source_certificate_not_issued");
    const installedCertificate = await certifyStateDeltaArtifact(installed, suite, {
      runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0,
      tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [],
    }, secret, "publisher-tenant");
    if (!installedCertificate) throw new Error("installed_template_certificate_not_issued");
    const sha256 = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const installedDigest = await sha256(installed);
    const candidateDigest = await sha256(candidate);
    let installedArtifactDigest = installedDigest;
    let installationListingId = "listing-installed";
    let installedArtifactJson = JSON.stringify(installed);
    let installedCertificateJson = JSON.stringify(installedCertificate);
    let installedPriceModel = "fixed_license";
    let installedPriceCents = 2500;
    let installationSchemaVersion: 1 | 2 = 1;
    let installationRequiredExtensionIds = ["ext_old"];
    let candidateArtifactJson = JSON.stringify(candidate);
    const stub = { fetch: async () => Response.json({ installations: [{ blueprint_id: installed.id, artifact_sha256: installedArtifactDigest,
      listing_id: installationListingId, setup_schema_version: installationSchemaVersion, setup_revision: 4,
      required_extension_ids: installationRequiredExtensionIds, project_ids: ["project-a"],
      status: "installed", error_code: null, created_at: "2026-11-13T00:00:00.000Z", updated_at: "2026-11-13T00:01:00.000Z" }] }) };
    const db = { prepare: (sql: string) => ({ bind: (..._args: unknown[]) => ({
      first: async () => ({ id: "space-update" }),
      all: async () => ({ results: sql.includes("FROM marketplace_listings source") ? [{
        source_listing_id: installationListingId, publisher_tenant_id: "publisher-tenant", blueprint_id: installed.id,
        installed_price_model: installedPriceModel, installed_price_cents: installedPriceCents, candidate_listing_id: "listing-new",
        installed_artifact_json: installedArtifactJson, installed_certificate_json: installedCertificateJson,
        candidate_artifact_json: candidateArtifactJson, candidate_certificate_json: JSON.stringify(certificate),
        candidate_price_model: "freemium_tiered", candidate_price_cents: 0,
      }] : [] }),
    }) }) };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db,
      SPACE_DO: { idFromName: () => "space-update-do", get: () => stub } } as never;
    const headers = { "x-naelao-tenant-id": "tenant-buyer", "x-naelao-user-id": "owner-buyer", "x-naelao-role": "owner",
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant-buyer") };
    const response = await worker.fetch(new Request("https://spaces/spaces/space-update/blueprints/installations", { headers }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const body = await response.json() as { installations: Array<Record<string, unknown>> };
    expect(body.installations[0]).toMatchObject({ source_update: { status: "update_available", source_listing_id: "listing-new",
      source_artifact_sha256: candidateDigest, terms_changed: true, setup_schema_changed: true,
      setup_migration_available: false,
      added_required_extensions: ["ext_new"], changed_required_extension_versions: [
        { extension_id: "ext_old", installed_version: "1.0.0", source_version: "2.0.0" },
      ] } });
    expect(JSON.stringify(body)).not.toContain("setup_values");
    expect(JSON.stringify(body)).not.toContain("Updated support");

    installedArtifactDigest = candidateDigest;
    installationListingId = "listing-new";
    installedArtifactJson = JSON.stringify(candidate);
    installedCertificateJson = JSON.stringify(certificate);
    installedPriceModel = "freemium_tiered";
    installedPriceCents = 0;
    installationSchemaVersion = 2;
    installationRequiredExtensionIds = ["ext_old", "ext_new"];
    const current = await worker.fetch(new Request("https://spaces/spaces/space-update/blueprints/installations", { headers }), env, {} as ExecutionContext);
    expect(await current.json()).toMatchObject({ installations: [{ source_update: { status: "current", source_listing_id: "listing-new" } }] });

    candidateArtifactJson = JSON.stringify({ ...candidate, metadata: { name: "Tampered source" } });
    const invalid = await worker.fetch(new Request("https://spaces/spaces/space-update/blueprints/installations", { headers }), env, {} as ExecutionContext);
    expect(await invalid.json()).toMatchObject({ installations: [{ source_update: { status: "source_unavailable", source_listing_id: null } }] });
  });

  it("offers only a matching signed migration for a setup-only same-publisher update", async () => {
    const secret = "setup-migration-availability-secret";
    const project = { id: "support", name: "Support", kind: "DualPane" as const, templateMode: "cowork_studio" as const,
      viewports: {}, systemPrompt: "", initialTasks: [], starterFiles: [],
      setupFields: [{ id: "greeting", type: "text" as const, label: "Greeting", required: true, minLength: 2, maxLength: 80 }] };
    const installed = blueprint({ id: "tpl_setup_update", metadata: { name: "Support" }, setupSchemaVersion: 1,
      projects: [project], requiredExtensions: [], requiredCredentials: [] });
    const artifactSha256 = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const installedDigest = await artifactSha256(installed);
    const installedSchemaDigest = await artifactSha256(validateBlueprintSetupSchema(installed));
    const candidate = { ...installed, metadata: { name: "Customer support" }, setupSchemaVersion: 2 as const,
      projects: [{ ...project, setupFields: [{ id: "welcome", type: "text" as const, label: "Welcome", required: true, minLength: 2, maxLength: 80 }] }],
      setupMigrations: [{ fromArtifactSha256: installedDigest, fromSchemaSha256: installedSchemaDigest, operations: [
        { kind: "rename" as const, fromProjectId: "support", fromFieldId: "greeting", toProjectId: "support", toFieldId: "welcome" },
      ] }] } satisfies SpaceBlueprint;
    const suite = { fixtures: Array.from({ length: 50 }, (_, index) => ({ id: `migration-${index}` })) };
    const certificate = await certifyStateDeltaArtifact(candidate, suite, { runner: "naelao-state-delta-v1", passed: 50,
      total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "publisher-tenant");
    const installedCertificate = await certifyStateDeltaArtifact(installed, suite, { runner: "naelao-state-delta-v1", passed: 50,
      total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "publisher-tenant");
    if (!certificate || !installedCertificate) throw new Error("template_source_certificate_not_issued");
    const candidateDigest = await artifactSha256(candidate);
    const forwarded: Array<{ path: string; body?: Record<string, unknown>; role: string | null }> = [];
    const stub = { fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/blueprint-installations") return Response.json({ installations: [{ blueprint_id: installed.id, artifact_sha256: installedDigest,
        listing_id: "listing-installed", setup_schema_version: 1, setup_revision: 3, required_extension_ids: [],
        project_ids: ["support"], status: "installed", error_code: null, created_at: "2026-11-13T00:00:00.000Z",
        updated_at: "2026-11-13T00:01:00.000Z" }] });
      const item: { path: string; body?: Record<string, unknown>; role: string | null } = {
        path: url.pathname, role: request.headers.get("x-naelao-role"),
      };
      item.body = await request.json() as Record<string, unknown>;
      forwarded.push(item);
      if (url.pathname.endsWith("/preview")) return Response.json({ source_listing_id: "listing-candidate", values: { support: { welcome: "Hello" } }, missing_required: [] });
      return Response.json({ applied: true, setup_revision: 4 });
    } };
    const candidateRow = {
        source_listing_id: "listing-installed", publisher_tenant_id: "publisher-tenant", blueprint_id: installed.id,
        installed_price_model: "fixed_license", installed_price_cents: 0, installed_artifact_json: JSON.stringify(installed),
        installed_certificate_json: JSON.stringify(installedCertificate), candidate_listing_id: "listing-candidate",
        candidate_artifact_json: JSON.stringify(candidate), candidate_certificate_json: JSON.stringify(certificate),
        candidate_price_model: "fixed_license", candidate_price_cents: 0,
      };
    const db = { prepare: (sql: string) => ({ bind: (..._args: unknown[]) => ({
      first: async () => sql.includes("FROM marketplace_listings source") ? candidateRow : { id: "space-setup-update" },
      all: async () => ({ results: sql.includes("FROM marketplace_listings source") ? [candidateRow] : [] }),
    }) }) };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db, SPACE_DO: { idFromName: () => "space-setup-update-do", get: () => stub } } as never;
    const headers = { "x-naelao-tenant-id": "buyer", "x-naelao-user-id": "owner", "x-naelao-role": "owner",
      "x-naelao-internal-token": await mintInternalToken(secret, "buyer") };
    const response = await worker.fetch(new Request("https://spaces/spaces/space-setup-update/blueprints/installations", { headers }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ installations: [{ source_update: {
      status: "update_available", source_listing_id: "listing-candidate", source_artifact_sha256: candidateDigest,
      terms_changed: false, setup_schema_changed: true, setup_migration_available: true,
      added_required_extensions: [], removed_required_extensions: [], changed_required_extension_versions: [],
    } }] });
    const updateHeaders = { ...headers, "content-type": "application/json" };
    const input = { source_listing_id: "listing-candidate", source_artifact_sha256: candidateDigest,
      expected_artifact_sha256: installedDigest, expected_setup_revision: 3 };
    const preview = await worker.fetch(new Request(`https://spaces/spaces/space-setup-update/blueprints/${installed.id}/setup-update-preview`, {
      method: "POST", headers: updateHeaders, body: JSON.stringify(input),
    }), env, {} as ExecutionContext);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ values: { support: { welcome: "Hello" } }, missing_required: [] });
    expect(forwarded[0]).toMatchObject({ path: "/blueprint-installation-setup-update/preview", role: "owner",
      body: { expected_artifact_sha256: installedDigest, expected_listing_id: "listing-installed", expected_setup_revision: 3,
        source_listing_id: "listing-candidate", source_artifact_sha256: candidateDigest } });
    const apply = await worker.fetch(new Request(`https://spaces/spaces/space-setup-update/blueprints/${installed.id}/setup-update-apply`, {
      method: "POST", headers: updateHeaders, body: JSON.stringify({ ...input, confirmed: true, setup_values: { support: { welcome: "Hello" } } }),
    }), env, {} as ExecutionContext);
    expect(apply.status).toBe(200);
    expect(forwarded[1]).toMatchObject({ path: "/blueprint-installation-setup-update/apply",
      body: { confirmed: true, setup_values: { support: { welcome: "Hello" } } } });
    const stale = await worker.fetch(new Request(`https://spaces/spaces/space-setup-update/blueprints/${installed.id}/setup-update-preview`, {
      method: "POST", headers: updateHeaders, body: JSON.stringify({ ...input, source_listing_id: "listing-stale" }),
    }), env, {} as ExecutionContext);
    expect(stale.status).toBe(409);
    const member = await worker.fetch(new Request(`https://spaces/spaces/space-setup-update/blueprints/${installed.id}/setup-update-preview`, {
      method: "POST", headers: { ...updateHeaders, "x-naelao-role": "member" }, body: JSON.stringify(input),
    }), env, {} as ExecutionContext);
    expect(member.status).toBe(403);
  });

  it("binds setup draft reads and writes to the pending signed listing and schema", async () => {
    const secret = "template-setup-draft-route-secret";
    const artifact = blueprint({ id: "tpl_draft", setupSchemaVersion: 1, projects: [{ id: "support", name: "Support", kind: "DualPane", templateMode: "cowork_studio",
      viewports: {}, systemPrompt: "", initialTasks: [], starterFiles: [], setupFields: [{ id: "greeting", type: "text", label: "Greeting", required: true, minLength: 2, maxLength: 80 }] }],
      requiredExtensions: [], requiredCredentials: [] });
    const suite = { fixtures: Array.from({ length: 50 }, (_, index) => ({ id: `draft-${index}` })) };
    const certificate = await certifyStateDeltaArtifact(artifact, suite, { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "tenant-a");
    if (!certificate) throw new Error("test_certificate_not_issued");
    const seen: Array<{ method: string; url: URL; body?: Record<string, unknown> }> = [];
    const stub = { fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/template-setup-draft") return new Response("not found", { status: 404 });
      const item: { method: string; url: URL; body?: Record<string, unknown> } = { method: request.method, url };
      if (request.method === "PUT") {
        expect(await verifyInternalToken(request.headers.get("x-naelao-internal-token"), "tenant-a", secret)).toBe(true);
        expect(request.headers.get("x-naelao-role")).toBe("owner");
        item.body = await request.json() as Record<string, unknown>;
      }
      seen.push(item);
      return Response.json(request.method === "GET" ? { exists: false, binding_matches: false, revision: 0 }
        : { exists: true, binding_matches: true, revision: 1, values: { support: { greeting: "Hello" } } });
    } };
    let pendingId = artifact.id;
    const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ first: async () => sql.includes("FROM spaces")
      ? { id: "space-draft", config_json: JSON.stringify({ pending_blueprint_id: pendingId, template_listing_id: "listing-a" }) }
      : sql.includes("marketplace_forks") ? { certificate_json: JSON.stringify(certificate), artifact_json: JSON.stringify(artifact) } : null }) }) };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db,
      SCRIPTS_R2: { get: async (key: string) => key === `blueprints/tenant-a/${artifact.id}.json` ? { json: async () => ({ blueprint: artifact, conformanceCertificate: certificate }) } : null },
      SPACE_DO: { idFromName: () => "space-draft-do", get: () => stub } } as never;
    const headers = { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const path = `https://spaces/spaces/space-draft/blueprints/${artifact.id}/setup-draft`;
    const initial = await worker.fetch(new Request(path, { headers }), env, {} as ExecutionContext);
    expect(initial.status).toBe(200);
    expect(seen[0]?.url.searchParams.get("listing_id")).toBe("listing-a");
    expect(seen[0]?.url.searchParams.get("setup_schema_version")).toBe("1");
    const save = await worker.fetch(new Request(path, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ expected_revision: 0, values: { support: { greeting: "Hello" } } }) }), env, {} as ExecutionContext);
    expect(save.status).toBe(200);
    expect(seen[1]?.body).toMatchObject({ expected_revision: 0, values: { support: { greeting: "Hello" } }, schema: [{ project_id: "support" }] });
    pendingId = "another-template";
    expect((await worker.fetch(new Request(path, { headers }), env, {} as ExecutionContext)).status).toBe(409);
    expect(seen).toHaveLength(2);
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
    let installations = [{ extension_id: "ext_required", scope: "PROJECT_BOUND", status: "active", release_version: "1.0.0", manifest_sha256: "a".repeat(64) }];
    const stub = { fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/extension-installations") return Response.json({ installations });
      if (url.pathname === "/blueprints/instantiate") {
        instantiateCalls++;
        expect(request.headers.get("x-naelao-tenant-id")).toBe("tenant-a");
        expect(await verifyInternalToken(request.headers.get("x-naelao-internal-token"), "tenant-a", secret)).toBe(true);
        return Response.json({ projectIds: [], taskCount: 0, fileCount: 0 }, { status: 201 });
      }
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
    installations = [{ extension_id: "ext_required", scope: "SPACE_SHARED", status: "staging", release_version: "1.0.0", manifest_sha256: "a".repeat(64) }];
    const stagedPreview = await worker.fetch(new Request(`https://spaces/spaces/space-a/blueprints/${artifact.id}/activation-preview`, { headers }), env, {} as ExecutionContext);
    expect(await stagedPreview.json()).toMatchObject({ ready: false, blockers: ["required_extension_not_active:ext_required"] });
    const stagedActivation = await worker.fetch(new Request(`https://spaces/spaces/space-a/blueprints/${artifact.id}/activate`, { method: "POST", headers }), env, {} as ExecutionContext);
    expect(stagedActivation.status).toBe(422);
    expect(instantiateCalls).toBe(0);
  });

  it("requires explicit owner review of signed extension requirements before template activation side effects", async () => {
    const secret = "extension-requirements-review-route-secret";
    const artifact = blueprint({ id: "tpl_review_required", projects: [], requiredExtensions: ["ext_support"], requiredCredentials: [], extensionRequirements: {
      knowledge: [{ extensionId: "ext_support", knowledgeId: "public_faq", purpose: "Answer approved questions", access: "owner_published_external", required: true }],
    } });
    const suite = { fixtures: Array.from({ length: 50 }, (_, index) => ({ id: `review-${index}` })) };
    const certificate = await certifyStateDeltaArtifact(artifact, suite, { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "tenant-review");
    if (!certificate) throw new Error("test_certificate_not_issued");
    let spaceDoCalls = 0;
    const env = { PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "space-review", config_json: "{}" }) }) }) },
      SCRIPTS_R2: { get: async () => ({ json: async () => ({ blueprint: artifact, conformanceCertificate: certificate }) }) },
      SPACE_DO: { idFromName: () => "space-review-do", get: () => ({ fetch: async () => { spaceDoCalls++; return Response.json({ installations: [] }); } }) },
    } as never;
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-review", "x-naelao-user-id": "owner-review",
      "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-review") };
    const response = await worker.fetch(new Request(`https://spaces/spaces/space-review/blueprints/${artifact.id}/activate`, {
      method: "POST", headers, body: JSON.stringify({ extension_requirements_reviewed: false }),
    }), env, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: "extension_requirements_confirmation_required" });
    expect(spaceDoCalls).toBe(0);
  });

  it("matches guided-install pricing to the exact selected listing and reports paid costs without inventing a total", async () => {
    const secret = "template-cost-preview-secret";
    const artifact = blueprint({ id: "tpl_cost", projects: [], requiredExtensions: [], requiredCredentials: [] });
    const suite = { fixtures: Array.from({ length: 50 }, (_, index) => ({ id: `cost-${index}` })) };
    const certificate = await certifyStateDeltaArtifact(artifact, suite, { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "publisher-tenant");
    if (!certificate) throw new Error("test_certificate_not_issued");
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const db = { prepare(sql: string) { return { bind(...values: unknown[]) { queries.push({ sql, values }); return { first: async () => {
      if (sql.includes("marketplace_license_purchases")) return { pricing_model: "fixed_license", price_cents: 2500,
        amount_cents: 2500, created_at: "2026-11-01T00:00:00.000Z" };
      if (sql.includes("marketplace_forks")) return { certificate_json: JSON.stringify(certificate), artifact_json: JSON.stringify(artifact) };
      if (sql.includes("config_json")) return { id: "space-cost", config_json: JSON.stringify({ template_listing_id: "listing-selected" }) };
      return { id: "space-cost" };
    } }; } }; } };
    const stub = { fetch: async (request: Request) => new URL(request.url).pathname === "/extension-installations"
      ? Response.json({ installations: [] }) : new Response("not found", { status: 404 }) };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db,
      SCRIPTS_R2: { get: async (key: string) => key === `blueprints/publisher-tenant/${artifact.id}.json`
        ? { json: async () => ({ blueprint: artifact, conformanceCertificate: certificate }) } : null },
      SPACE_DO: { idFromName: () => "space-cost-do", get: () => stub } } as never;
    const headers = { "x-naelao-tenant-id": "tenant-buyer", "x-naelao-user-id": "owner", "x-naelao-role": "owner",
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant-buyer") };
    const response = await worker.fetch(new Request(`https://spaces/spaces/space-cost/blueprints/${artifact.id}/activation-preview?conversations_per_month=200&interactions_per_conversation=8`, { headers }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ cost_estimate: {
      status: "partial", currency: "USD", total_estimate_cents: null,
      known_one_time_costs: [{ amount_cents: 2500, basis: "recorded_purchase", already_paid: true,
        paid_at: "2026-11-01T00:00:00.000Z" }],
      expected_monthly_usage: { conversations: 200, interactions_per_conversation: 8, projected_interactions: 1600, estimated_cost_cents: null },
    } });
    expect(queries.find(query => query.sql.includes("marketplace_license_purchases"))?.values)
      .toEqual(["tenant-buyer", artifact.id, "listing-selected"]);
    const invalidUsage = await worker.fetch(new Request(`https://spaces/spaces/space-cost/blueprints/${artifact.id}/activation-preview?conversations_per_month=200&interactions_per_conversation=501`, { headers }), env, {} as ExecutionContext);
    expect(invalidUsage.status).toBe(400);
    expect(await invalidUsage.json()).toMatchObject({ error_code: "template_expected_usage_invalid" });
  });

  it("activates a certified template through the host for a fresh Space", async () => {
    const secret = "fresh-space-activation-secret";
    const artifact = blueprint({ id: "tpl_fresh_target", projects: [], requiredExtensions: [], requiredCredentials: [], coordinationDefaults: { memberFactsEnabled: true } });
    const suite = { fixtures: Array.from({ length: 50 }, (_, index) => ({ id: `fresh-${index}` })) };
    const certificate = await certifyStateDeltaArtifact(artifact, suite, { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "tenant-fresh");
    if (!certificate) throw new Error("test_certificate_not_issued");
    let activationCount = 0, activationBody: Record<string, unknown> | null = null, policyEnabled = false, policyRevision = 0;
    let policyWrite: Record<string, unknown> | null = null;
    let spaceConfig = "{}";
    const stub = { fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/extension-installations") return Response.json({ installations: [] });
      if (url.pathname === "/space-coordination-policy" && request.method === "GET") return Response.json({ configured: policyRevision > 0,
        member_facts_enabled: policyEnabled, revision: policyRevision, active_member_facts: 0 });
      if (url.pathname === "/space-coordination-policy" && request.method === "PUT") {
        policyWrite = await request.json() as Record<string, unknown>;
        if (policyRevision !== 0 || policyWrite.expected_revision !== 0) return Response.json({ error_code: "coordination_policy_revision_conflict" }, { status: 409 });
        policyEnabled = policyWrite.member_facts_enabled === true; policyRevision = 1;
        return Response.json({ configured: true, member_facts_enabled: policyEnabled, revision: policyRevision, active_member_facts: 0 });
      }
      if (url.pathname === "/blueprints/instantiate") { activationCount++; activationBody = await request.json() as Record<string, unknown>; return Response.json({ projectIds: [], taskCount: 0, fileCount: 0 }, { status: 201 }); }
      return new Response("not found", { status: 404 });
    } };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "fresh-space", config_json: spaceConfig }), run: async () => ({ success: true }) }) }) },
      SCRIPTS_R2: { get: async (key: string) => key === `blueprints/tenant-fresh/${artifact.id}.json` ? { json: async () => ({ blueprint: artifact, conformanceCertificate: certificate }) } : null },
      SPACE_DO: { idFromName: () => "fresh-space-do", get: () => stub } } as never;
    const headers = { "x-naelao-tenant-id": "tenant-fresh", "x-naelao-user-id": "owner", "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-fresh") };
    const preview = await worker.fetch(new Request(`https://spaces/spaces/fresh-space/blueprints/${artifact.id}/activation-preview`, { headers }), env, {} as ExecutionContext);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ ready: true, target_space_id: "fresh-space", requires_human_activation: true,
      coordination_defaults: { memberFactsEnabled: true }, coordination_policy_current: { configured: false, revision: 0, member_facts_enabled: false } });
    spaceConfig = JSON.stringify({ template_listing_id: "listing-selected" });
    const activation = await worker.fetch(new Request(`https://spaces/spaces/fresh-space/blueprints/${artifact.id}/activate`, { method: "POST", headers,
      body: JSON.stringify({ apply_coordination_default: true }) }), env, {} as ExecutionContext);
    expect(activation.status).toBe(201);
    expect(activationCount).toBe(1);
    expect(activationBody).toMatchObject({ listing_id: "listing-selected", blueprint: { id: artifact.id } });
    expect(policyWrite).toMatchObject({ member_facts_enabled: true, expected_revision: 0, actor_id: "owner", actor_role: "owner", confirmed: true });
    expect(policyEnabled).toBe(true);
    expect(await activation.json()).toMatchObject({ coordinationPolicyApplication: { status: "applied", member_facts_enabled: true, revision: 1 } });
    const replay = await worker.fetch(new Request(`https://spaces/spaces/fresh-space/blueprints/${artifact.id}/activate`, { method: "POST", headers,
      body: JSON.stringify({ apply_coordination_default: true }) }), env, {} as ExecutionContext);
    expect(replay.status).toBe(201);
    expect(policyEnabled).toBe(true);
    expect(await replay.json()).toMatchObject({ coordinationPolicyApplication: { status: "existing_policy_preserved", member_facts_enabled: true, revision: 1 } });
  });

  it("cannot bypass required runtime blockers by calling activation directly", async () => {
    const secret = "required-runtime-activation-secret";
    const project = { id: "project-with-gpu", name: "GPU project", kind: "DualPane" as const, templateMode: "cowork_studio" as const,
      viewports: {}, systemPrompt: "", initialTasks: [], starterFiles: [], runtimeRequirements: [
        { id: "gpu", capabilities: ["cuda"], required: true, priority: 0, dependencies: [] },
      ] };
    const artifact = blueprint({ id: "tpl_required_runtime", projects: [project], requiredExtensions: [], requiredCredentials: [] });
    const suite = { fixtures: Array.from({ length: 50 }, (_, index) => ({ id: `runtime-${index}` })) };
    const certificate = await certifyStateDeltaArtifact(artifact, suite, { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "tenant-runtime");
    if (!certificate) throw new Error("test_certificate_not_issued");
    let instantiateCalls = 0;
    const stub = { fetch: async (request: Request) => {
      if (new URL(request.url).pathname === "/extension-installations") return Response.json({ installations: [] });
      if (new URL(request.url).pathname === "/blueprints/instantiate") { instantiateCalls++; return Response.json({ ok: true }, { status: 201 }); }
      return new Response("not found", { status: 404 });
    } };
    const env = { PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "space-runtime" }) }) }) },
      SCRIPTS_R2: { get: async (key: string) => key === `blueprints/tenant-runtime/${artifact.id}.json` ? { json: async () => ({ blueprint: artifact, conformanceCertificate: certificate }) } : null },
      SPACE_DO: { idFromName: () => "space-runtime-do", get: () => stub } } as never;
    const headers = { "x-naelao-tenant-id": "tenant-runtime", "x-naelao-user-id": "owner", "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-runtime") };
    const response = await worker.fetch(new Request(`https://spaces/spaces/space-runtime/blueprints/${artifact.id}/activate`, { method: "POST", headers }), env, {} as ExecutionContext);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error_code: "required_runtime_unavailable", blockers: ["required_runtime_unavailable:project-with-gpu:gpu"] });
    expect(instantiateCalls).toBe(0);
  });

  it("installs a required approved runtime into the newly created project after owner approval", async () => {
    const secret = "runtime-template-auto-install-secret";
    const image = "registry.example/ffmpeg@sha256:" + "a".repeat(64);
    const runtimeManifest = { id: "ext_runtime_ffmpeg", type: "extension", declaredPermissions: ["container:execute"], capabilityRequirements: ["native-execution"],
      gadgets: [], daemons: [], commands: [], containers: [{ schemaVersion: "1.0", kind: "container", id: "ffmpeg", version: "1.0.0",
        permissions: [{ scope: "PROJECT_BOUND", actions: ["execute"], resource: "workspace" }], capabilityRequirements: ["native-execution"], lifecycle: {},
        image, resources: { memoryMb: 4096, cpuCores: 0.5, timeoutSeconds: 60 }, exportedBinaries: ["ffmpeg"], networkPolicy: "none" }] };
    const project = { id: "media-project", name: "Media Project", kind: "DualPane" as const, templateMode: "cowork_studio" as const,
      configuration: { executionCeiling: 6 }, viewports: {}, systemPrompt: "", initialTasks: [], starterFiles: [],
      setupFields: [{ id: "locale", type: "select", label: "Language", options: [{ value: "en", label: "English" }, { value: "es", label: "Spanish" }], defaultValue: "en" }],
      runtimeRequirements: [
        { id: "ffmpeg", capabilities: ["ffmpeg"], required: true, priority: 0, dependencies: [] },
      ] };
    const artifact = blueprint({ id: "tpl_runtime_project", setupSchemaVersion: 1, projects: [project], requiredExtensions: [], requiredCredentials: [] });
    const suite = { fixtures: Array.from({ length: 50 }, (_, index) => ({ id: `runtime-install-${index}` })) };
    const certificate = await certifyStateDeltaArtifact(artifact, suite, { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "tenant-runtime-install");
    if (!certificate) throw new Error("test_certificate_not_issued");
    const stored = new Map([[`blueprints/tenant-runtime-install/${artifact.id}.json`, { blueprint: artifact, conformanceCertificate: certificate }]]);
    const installs: Array<Record<string, unknown>> = [];
    let activationRequests = 0, createdProjects = 0;
    const setupValuesSeen: unknown[] = [];
    const stub = { fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/extension-installations") return Response.json({ installations: [] });
      if (url.pathname === "/blueprints/instantiate") {
        setupValuesSeen.push((await request.clone().json() as { setup_values?: unknown }).setup_values);
        activationRequests++; if (activationRequests === 1) createdProjects++;
        return Response.json({ projectIds: ["created-project"], taskCount: 0, fileCount: 0 }, { status: activationRequests === 1 ? 201 : 200 });
      }
      if (url.pathname === "/projects/created-project") return Response.json({ execution_ceiling: 6 });
      if (url.pathname === "/extensions" && request.method === "POST") {
        installs.push(await request.json() as Record<string, unknown>);
        return installs.length === 1 ? Response.json({ error_code: "temporary_install_failure" }, { status: 503 }) : Response.json({ installationId: "runtime-installation" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    } };
    const db = { prepare: (sql: string) => ({ bind: () => ({ first: async () => sql.includes("FROM orgs") ? { plan_tier: "free" } : { id: "space-runtime-install" }, run: async () => ({ success: true }) }) }) };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db,
      SCRIPTS_R2: { get: async (key: string) => stored.has(key) ? { json: async () => stored.get(key) } : null },
      AGENTS_WORKER: { fetch: async () => Response.json({ images: [{ id: "ffmpeg", name: "FFmpeg", available: true, billing_tier: "free", image, exported_binaries: ["ffmpeg"], install_manifest: runtimeManifest }] }) },
      SPACE_DO: { idFromName: () => "runtime-install-do", get: () => stub } } as never;
    const headers = { "x-naelao-tenant-id": "tenant-runtime-install", "x-naelao-user-id": "owner", "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-runtime-install") };
    const preview = await worker.fetch(new Request(`https://spaces/spaces/space-runtime-install/blueprints/${artifact.id}/activation-preview`, { headers }), env, {} as ExecutionContext);
    expect(await preview.json()).toMatchObject({ ready: true, setup_schema_version: 1, setup_fields: [{ project_id: "media-project", fields: [{ id: "locale", type: "select" }] }], runtime_requirements: [{ status: "installable", reason: "owner_approval_required" }], installs_or_grants_applied: false });
    const activationUrl = `https://spaces/spaces/space-runtime-install/blueprints/${artifact.id}/activate`;
    const invalid = await worker.fetch(new Request(activationUrl, { method: "POST", headers, body: JSON.stringify({ setup_values: { "media-project": { locale: "de" } } }) }), env, {} as ExecutionContext);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error_code: "template_setup_values_invalid" });
    expect(activationRequests).toBe(0);
    const activationBody = JSON.stringify({ setup_values: { "media-project": { locale: "es" } } });
    const interrupted = await worker.fetch(new Request(activationUrl, { method: "POST", headers, body: activationBody }), env, {} as ExecutionContext);
    expect(interrupted.status).toBe(503);
    const response = await worker.fetch(new Request(activationUrl, { method: "POST", headers, body: activationBody }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(createdProjects).toBe(1);
    expect(installs).toHaveLength(2);
    expect(installs[0]).toMatchObject({ installedBy: "owner", scope: "PROJECT_SHARED", projectId: "created-project", manifest: { id: "ext_runtime_ffmpeg" } });
    expect(setupValuesSeen).toEqual([{ "media-project": { locale: "es" } }, { "media-project": { locale: "es" } }]);
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
      new Map([["ext_installed", { version: "1.0.0", digest: "a".repeat(64), status: "active" }]]),
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
      { extension_id: "ext_supported", status: "installable", required_version: "1.0.0", available_version: "1.0.0", available_digest: "b".repeat(64) },
    ]);
    expect(result.blockers).toEqual([]);
  });

  it("blocks an installed release that does not match the immutable version pin", () => {
    const pinned = blueprint({ requiredExtensions: ["ext_installed"], requiredExtensionVersions: { ext_installed: "2.0.0" } });
    const result = previewBlueprintActivation(pinned, new Map([["ext_installed", { version: "1.0.0", digest: "a".repeat(64), status: "active" }]]), new Map());
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

  it("blocks staged or unknown installation states even when the release matches", () => {
    for (const status of ["staging", "pending", undefined]) {
      const result = previewBlueprintActivation(blueprint({ requiredExtensions: ["ext_installed"] }),
        new Map([["ext_installed", { version: "1.0.0", digest: "a".repeat(64), status }]]), new Map());
      expect(result.ready).toBe(false);
      expect(result.dependencies[0]).toMatchObject({ extension_id: "ext_installed", status: "not_active" });
      expect(result.blockers).toEqual(["required_extension_not_active:ext_installed"]);
    }
  });
});


it("blocks a fresh template whose required runtime slots exceed its plan before activation", () => {
  const requirements = ["one", "two", "three"].map(id => ({ id, capabilities: ["bash"], required: true, priority: 0, dependencies: [] }));
  const project = { id: "project-a", name: "A", kind: "DualPane" as const, templateMode: "cowork_studio" as const, configuration: { executionCeiling: 6 }, viewports: {}, systemPrompt: "", initialTasks: [], starterFiles: [], runtimeRequirements: requirements };
  const artifact = blueprint({ projects: [project], requiredExtensions: [], requiredCredentials: [] });
  const images = requirements.map(item => ({ id: item.id, name: item.id, available: true, plan_available: true, install_manifest: { id: `ext_${item.id}`, containers: [{}] } }));
  const free = blueprintRuntimeInstallability(artifact, images, "free");
  expect([...free.values()].every(item => !item.installable && item.reason === "subscription_slot_limit")).toBe(true);
  expect(previewBlueprintActivation(artifact, new Map(), new Map(), free).ready).toBe(false);
  expect([...blueprintRuntimeInstallability(artifact, images, "growth").values()].every(item => item.installable)).toBe(true);
});
