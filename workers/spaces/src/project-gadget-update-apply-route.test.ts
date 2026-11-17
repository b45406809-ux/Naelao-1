import { describe, expect, it, vi } from "vitest";
import { signHmac, verifyHmac } from "@naelao/crypto";
import { digestExtensionManifest, exportExtensionPublisherPublicKey,
  extensionPublisherSigningPayload, generateExtensionPublisherKeyPair, signExtensionPublisherRelease, validateExtensionManifest } from "@naelao/agent-sdk";
import { mintInternalToken } from "@naelao/http";
import spacesWorker from "./index.js";
import { projectBoundExtensionUpdateClaims } from "./project-extension-update-review.js";

const secret = "project-gadget-update-apply-route-secret";
const extensionId = "ext_project_migrate";
const html = "<main>Project records</main>";

function manifest(version: string, recordsMigrations: Array<{ version: number; description: string; up: string }>,
  accountsMigrations: Array<{ version: number; description: string; up: string }>) {
  return validateExtensionManifest({ id: extensionId, type: "extension", declaredPermissions: [],
    capabilityRequirements: ["extension.project_canvas"], gadgets: [], daemons: [], commands: [],
    bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: extensionId, version, primitives: [
      { schemaVersion: "1.0", kind: "canvas", id: "dashboard", version, permissions: [], capabilityRequirements: [], lifecycle: {},
        component: "./index.html", layout: "CanvasMount", dynamicPage: false },
      { schemaVersion: "1.0", kind: "gadget", id: "records", version, permissions: [], capabilityRequirements: [], lifecycle: {},
        scope: "PROJECT_BOUND", schemaSql: "CREATE TABLE records(id TEXT PRIMARY KEY);", migrations: recordsMigrations },
      { schemaVersion: "1.0", kind: "gadget", id: "accounts", version, permissions: [], capabilityRequirements: [], lifecycle: {},
        scope: "PROJECT_BOUND", schemaSql: "CREATE TABLE accounts(id TEXT PRIMARY KEY);", migrations: accountsMigrations },
    ] },
  }, { gatekeeperCapabilities: ["extension.project_canvas"] });
}

async function harness(options: { activationFailsOnce?: boolean } = {}) {
  const key = await generateExtensionPublisherKeyPair(), publicKey = await exportExtensionPublisherPublicKey(key.publicKey);
  const oldMigration = { version: 1, description: "create records", up: "CREATE TABLE records(id TEXT PRIMARY KEY);" };
  const newMigration = { version: 2, description: "add status", up: "ALTER TABLE records ADD COLUMN status TEXT DEFAULT 'open';" };
  const oldAccountsMigration = { version: 1, description: "create accounts", up: "CREATE TABLE accounts(id TEXT PRIMARY KEY);" };
  const newAccountsMigration = { version: 2, description: "add name", up: "ALTER TABLE accounts ADD COLUMN name TEXT;" };
  const source = manifest("1.0.0", [oldMigration], [oldAccountsMigration]);
  const candidate = manifest("2.0.0", [oldMigration, newMigration], [oldAccountsMigration, newAccountsMigration]);
  const artifacts = { "./index.html": html }, entries = Object.entries(artifacts).sort(([a], [b]) => a.localeCompare(b));
  const sourceSignature = await signExtensionPublisherRelease({ privateKey: key.privateKey, publicKey: key.publicKey,
    manifestJson: JSON.stringify(source), artifacts });
  const candidateSignature = await signExtensionPublisherRelease({ privateKey: key.privateKey, publicKey: key.publicKey,
    manifestJson: JSON.stringify(candidate), artifacts });
  const artifactSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(entries))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const publisherKeyId = candidateSignature.keyId, instanceId = "instance-a";
  const sourceManifestSha256 = await digestExtensionManifest(source), candidateManifestSha256 = await digestExtensionManifest(candidate);
  const sourceArtifactSha256 = "b".repeat(64), sourceGeneration = 4;
  const claims = projectBoundExtensionUpdateClaims({ tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a",
    actorId: "owner-a", installationId: instanceId, extensionId, installationGeneration: sourceGeneration,
    fromVersion: "1.0.0", toVersion: "2.0.0", sourceManifestSha256, candidateManifestSha256,
    sourceArtifactSha256, artifactSha256, publisherId: "pub_project", publisherKeyId,
    expiresAt: Date.now() + 5 * 60_000, requestId: "123e4567-e89b-12d3-a456-426614174000" });
  const payload = JSON.stringify(claims);
  const updateReviewToken = `${btoa(payload).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}.${await signHmac(payload, secret)}`;
  const installed = { instance_id: instanceId, extension_id: extensionId, project_id: "project-a", scope: "PROJECT_BOUND",
    instance_key: "default", status: "disabled", generation: sourceGeneration, release_version: "1.0.0",
    manifest_sha256: sourceManifestSha256, pinned_artifact_sha256: sourceArtifactSha256,
    publisher_id: "pub_project", publisher_key_id: publisherKeyId, publisher_attestation_valid: true,
    manifest: source, permissions: [], capabilities: ["extension.project_canvas"] };
  let state: "source" | "staging" | "active" = "source";
  let migrationFailsOnce = options.activationFailsOnce !== true, activationFailsOnce = options.activationFailsOnce === true;
  let publisherActive = true;
  const spaceRequests: Request[] = [], actorRequests: Request[] = [];
  const spaceStub = { fetch: vi.fn(async (request: Request) => {
    spaceRequests.push(request);
    const url = new URL(request.url), path = url.pathname;
    if (path === "/projects/project-a/automation-access") return Response.json({ project_id: "project-a", can_manage: true });
    if (path === "/extension-installations") {
      const row = state === "source" ? installed : { ...installed, status: state === "active" ? "active" : "staging",
        generation: sourceGeneration + 1, release_version: "2.0.0", manifest_sha256: candidateManifestSha256,
        pinned_artifact_sha256: artifactSha256, manifest: candidate };
      return Response.json({ installations: [row] });
    }
    if (path === "/extension-releases") return Response.json({ releases: [
      { version: "1.0.0", manifest: source, artifactSha256: sourceArtifactSha256, signatureValid: true,
        publisher: { id: "pub_project", keyId: publisherKeyId } },
      { version: "2.0.0", manifest: candidate, artifactSha256, signatureValid: true,
        publisher: { id: "pub_project", keyId: publisherKeyId } },
    ] });
    if (path === "/extension-package-release") return Response.json({ release: { extension_id: extensionId, version: "1.0.0",
      manifest_json: JSON.stringify(source), artifact_sha256: sourceArtifactSha256,
      publisher: { id: "pub_project", key_id: publisherKeyId } } });
    if (path === "/extension-runtime-work") return Response.json({ active_work_count: 0 });
    if (path === "/project-extension-update-receipt") return state === "source"
      ? Response.json({ error_code: "project_extension_update_receipt_not_found" }, { status: 404 })
      : Response.json({ receipt: { request_id: claims.requestId, tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a",
        instance_id: instanceId, extension_id: extensionId, actor_id: "owner-a", source_generation: sourceGeneration,
        applied_generation: sourceGeneration + 1, from_version: "1.0.0", to_version: "2.0.0", source_manifest_sha256: sourceManifestSha256,
        candidate_manifest_sha256: candidateManifestSha256, source_artifact_sha256: sourceArtifactSha256, artifact_sha256: artifactSha256,
        publisher_id: "pub_project", publisher_key_id: publisherKeyId, status: state === "active" ? "active" : "staged" } });
    if (path === "/extensions" && request.method === "POST") {
      const body = await request.clone().json() as { projectUpdateRecoveryRequestId?: string };
      if (body.projectUpdateRecoveryRequestId && state === "source") return Response.json({ error_code: "unexpected_recovery" }, { status: 409 });
      state = "staging";
      return Response.json({ installationId: instanceId, installationGeneration: sourceGeneration + 1,
        release: { version: "2.0.0", artifactSha256, hostSignature: "c".repeat(64), publisher: { keyId: publisherKeyId } } }, { status: 201 });
    }
    if (path === "/extension-installation/activate") {
      if (activationFailsOnce) { activationFailsOnce = false; return Response.json({ error_code: "temporary_activation_failure" }, { status: 503 }); }
      state = "active"; return Response.json({ activated: true, status: "active" });
    }
    if (path === "/projects/project-a" && request.method === "PATCH") return Response.json({ updated: true });
    return Response.json({ error_code: "unexpected_space_route", path }, { status: 404 });
  }) };
  const microApp = { fetch: vi.fn(async (request: Request) => {
    actorRequests.push(request);
    const body = await request.clone().json().catch(() => ({})) as { claims?: { appId?: string } };
    if (new URL(request.url).pathname === "/extension-schema-update" && body.claims?.appId === "records" && migrationFailsOnce) {
      migrationFailsOnce = false;
      return Response.json({ error_code: "gadget_schema_update_apply_failed", retryable: true }, { status: 503 });
    }
    return Response.json({ initialized: true, applied: true, replayed: actorRequests.filter(item => new URL(item.url).pathname === "/extension-schema-update").length > 1 });
  }) };
  const env = { PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({
      first: async () => sql.includes("FROM spaces WHERE id") ? { tenant_id: "tenant-a", name: "Space" }
        : sql.includes("FROM extension_publisher_keys") && publisherActive ? { publisher_id: "pub_project", public_key_b64url: publicKey, status: "active" } : null,
      all: async () => ({ results: publisherActive ? [{ key_id: publisherKeyId }] : [] }),
    }) }) },
    SPACE_DO: { idFromName: () => "space-do", get: () => spaceStub },
    MICRO_APP_DO: { idFromName: () => "micro-app", get: () => microApp },
    SCRIPTS_R2: { get: async () => null, head: async () => null, put: async () => ({ key: "written" }) },
  } as never;
  const request = async () => new Request(`https://spaces.test/spaces/space-a/projects/project-a/extensions`, {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"), "x-naelao-tenant-id": "tenant-a",
      "x-naelao-user-id": "owner-a", "x-naelao-role": "owner" },
    body: JSON.stringify({ manifest: candidate, artifacts, upgrade: true, updateReviewToken, publisherSignature: {
      key_id: publisherKeyId, signature: candidateSignature.signature }, instanceKey: "default" }),
  });
  return { env, request, spaceRequests, actorRequests, revokePublisher: () => { publisherActive = false; }, get state() { return state; } };
}

describe("Project Gadget migration apply route", () => {
  it("preserves a staged receipt after a later Gadget migration fails and replays prior receipts", async () => {
    const h = await harness();
    const first = await spacesWorker.fetch(await h.request(), h.env);
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(503);
    expect(h.state).toBe("staging");
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/extension-installation/abort")).toBe(false);

    const second = await spacesWorker.fetch(await h.request(), h.env);
    expect(second.status, JSON.stringify(await second.clone().json())).toBe(201);
    expect(h.state).toBe("active");
    const migrationCalls = h.actorRequests.filter(request => new URL(request.url).pathname === "/extension-schema-update");
    expect(migrationCalls).toHaveLength(4);
    const calls = await Promise.all(migrationCalls.map(async request => await request.clone().json() as { claims: Record<string, unknown>; migrations: unknown[]; signature: string }));
    const firstCall = calls[0]!, secondCall = calls[1]!, replayFirst = calls[2]!, retrySecond = calls[3]!;
    expect(firstCall.claims).toMatchObject({ purpose: "project_bound_gadget_schema_update", projectId: "project-a",
      installationId: "instance-a", installationGeneration: 4, fromVersion: "1.0.0", toVersion: "2.0.0", appId: "accounts" });
    expect(await verifyHmac(JSON.stringify(firstCall.claims), firstCall.signature, secret)).toBe(true);
    expect(secondCall.claims).toMatchObject({ appId: "records" });
    expect(replayFirst.claims).toEqual(firstCall.claims);
    expect(retrySecond.claims).toEqual(secondCall.claims);
    expect(replayFirst.migrations).toEqual(firstCall.migrations);
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/extension-installation/activate")).toBe(true);
  });

  it("replays Gadget receipts and actor initialization after activation fails", async () => {
    const h = await harness({ activationFailsOnce: true });
    const first = await spacesWorker.fetch(await h.request(), h.env);
    expect(first.status).toBe(503);
    expect(h.state).toBe("staging");
    const second = await spacesWorker.fetch(await h.request(), h.env);
    expect(second.status, JSON.stringify(await second.clone().json())).toBe(201);
    expect(h.state).toBe("active");
    const migrationCalls = h.actorRequests.filter(request => new URL(request.url).pathname === "/extension-schema-update");
    expect(migrationCalls).toHaveLength(4);
    expect(h.spaceRequests.filter(request => new URL(request.url).pathname === "/extension-installation/activate")).toHaveLength(2);
  });

  it("rejects a reviewed migration before staging when its publisher key is revoked", async () => {
    const h = await harness();
    h.revokePublisher();
    const response = await spacesWorker.fetch(await h.request(), h.env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "extension_publisher_key_untrusted_or_revoked" });
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/extensions")).toBe(false);
    expect(h.actorRequests.filter(request => new URL(request.url).pathname === "/extension-schema-update")).toHaveLength(0);
  });
});

describe("Project extension staged recovery route", () => {
  async function recoveryHarness(options: { tamperArtifact?: boolean; revokePublisher?: boolean } = {}) {
    const key = await generateExtensionPublisherKeyPair(), publicKey = await exportExtensionPublisherPublicKey(key.publicKey);
    const source = manifest("1.0.0", [], []), candidate = manifest("2.0.0", [], []);
    const manifestJson = JSON.stringify(candidate), artifacts = { "./index.html": html };
    const signature = await signExtensionPublisherRelease({ privateKey: key.privateKey, publicKey: key.publicKey, manifestJson, artifacts });
    const artifactSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(Object.entries(artifacts)))))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const requestId = "523e4567-e89b-12d3-a456-426614174000", installationId = "instance-recovery";
    const receipt = { request_id: requestId, tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a",
      instance_id: installationId, extension_id: extensionId, actor_id: "owner-a", source_generation: 4, applied_generation: 5,
      from_version: "1.0.0", to_version: "2.0.0", source_manifest_sha256: await digestExtensionManifest(source),
      candidate_manifest_sha256: await digestExtensionManifest(candidate), source_artifact_sha256: "b".repeat(64), artifact_sha256: artifactSha256,
      publisher_id: "pub_project", publisher_key_id: signature.keyId, status: "staged" };
    const sourceRelease = { release: { manifest_json: JSON.stringify(source), artifact_sha256: receipt.source_artifact_sha256,
      publisher: { id: "pub_project", key_id: signature.keyId } } };
    const candidateRelease = { release: { manifest_json: manifestJson, artifact_sha256: artifactSha256,
      publisher: { id: "pub_project", key_id: signature.keyId, signature: signature.signature,
        payload_sha256: await digest(extensionPublisherSigningPayload(manifestJson, artifacts)) } } };
    const objects = new Map<string, string>([
      [`spaces/space-a/extensions/${extensionId}/2.0.0/.publisher-source/index.html`, html],
      [`spaces/space-a/extensions/${extensionId}/2.0.0/index.html`, options.tamperArtifact ? `${html} changed` : html],
    ]);
    const stub = { fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url), path = url.pathname;
      if (path === "/projects/project-a/automation-access") return Response.json({ project_id: "project-a", can_manage: true });
      if (path === "/project-extension-update-receipt") return Response.json({ receipt });
      if (path === "/extension-installations") return Response.json({ installations: [{ instance_id: installationId, extension_id: extensionId,
        project_id: "project-a", scope: "PROJECT_BOUND", status: "staging", generation: 5, release_version: "2.0.0",
        instance_key: "default", manifest_sha256: receipt.candidate_manifest_sha256, manifest: candidate }] });
      if (path === "/extension-package-release") return url.searchParams.get("version") === "1.0.0" ? Response.json(sourceRelease) : Response.json(candidateRelease);
      return Response.json({ error_code: "unexpected_route" }, { status: 404 });
    }) };
    const env = { PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({
        first: async () => sql.includes("FROM spaces WHERE id") ? { tenant_id: "tenant-a", name: "Space" }
          : sql.includes("FROM extension_publisher_keys") && !options.revokePublisher ? { publisher_id: "pub_project", public_key_b64url: publicKey } : null,
        all: async () => ({ results: [] }),
      }) }) },
      SPACE_DO: { idFromName: () => "space-do", get: () => stub },
      SCRIPTS_R2: { get: async (objectKey: string) => {
        const value = objects.get(objectKey); if (value === undefined) return null;
        const bytes = new TextEncoder().encode(value);
        return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
      } },
    } as never;
    const request = () => new Request(`https://spaces.test/spaces/space-a/projects/project-a/extension-installations/${installationId}/update-receipts/${requestId}/recover`, {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": "unused-by-owner-auth",
        "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner" }, body: "{}",
    });
    return { env, request, stub, receipt, requestId };
  }

  it("revalidates release/source pins and returns a short token for the original staged request", async () => {
    const h = await recoveryHarness();
    const request = await h.request();
    request.headers.set("x-naelao-internal-token", await mintInternalToken(secret, "tenant-a"));
    const response = await spacesWorker.fetch(request, h.env);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const { recovery } = await response.json() as { recovery: { requestId: string; updateReviewToken: string; manifest: unknown } };
    expect(recovery.requestId).toBe(h.requestId);
    expect(recovery.manifest).toEqual(manifest("2.0.0", [], []));
    const token = recovery.updateReviewToken, separator = token.lastIndexOf("."), encoded = token.slice(0, separator);
    const payload = atob(encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - encoded.length % 4) % 4));
    const claims = JSON.parse(payload) as { requestId: string; installationGeneration: number; expiresAt: number };
    expect(claims).toMatchObject({ requestId: h.requestId, installationGeneration: h.receipt.source_generation });
    expect(claims.expiresAt).toBeGreaterThan(Date.now());
    expect(await verifyHmac(payload, token.slice(separator + 1), secret)).toBe(true);
  });

  it("rejects changed stored artifacts and a revoked publisher key", async () => {
    const changed = await recoveryHarness({ tamperArtifact: true });
    const changedRequest = await changed.request();
    changedRequest.headers.set("x-naelao-internal-token", await mintInternalToken(secret, "tenant-a"));
    expect((await spacesWorker.fetch(changedRequest, changed.env)).status).toBe(409);

    const revoked = await recoveryHarness({ revokePublisher: true });
    const revokedRequest = await revoked.request();
    revokedRequest.headers.set("x-naelao-internal-token", await mintInternalToken(secret, "tenant-a"));
    const response = await spacesWorker.fetch(revokedRequest, revoked.env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "extension_publisher_key_untrusted_or_revoked" });
  });
});
