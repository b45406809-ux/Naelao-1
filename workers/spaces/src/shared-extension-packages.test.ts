import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { signHmac } from "@naelao/crypto";
import { exportExtensionPublisherPublicKey, extensionPublisherSigningPayload, generateExtensionPublisherKeyPair,
  signExtensionPublisherRelease, validateExtensionManifest } from "@naelao/agent-sdk";
import spacesWorker from "./index.js";

const secret = "shared-extension-package-route-secret";
const html = "<main>Customer dashboard</main>";
const handler = "export default async function handle() { return { ok: true }; }";
const manifest = validateExtensionManifest({
  id: "ext_customer_voice", type: "extension", declaredPermissions: ["assistant.phone.read", "assistant.phone.simulate"], capabilityRequirements: ["extension.project_canvas", "assistant.phone.read", "assistant.phone.simulate"],
  gadgets: [], daemons: [], commands: [],
  bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_customer_voice", version: "1.2.0", primitives: [
    { schemaVersion: "1.0", kind: "canvas", id: "voice_dashboard", version: "1.2.0", permissions: [], capabilityRequirements: [], lifecycle: {},
      component: "./dashboard.html", layout: "CanvasMount", dynamicPage: false },
    { schemaVersion: "1.0", kind: "channel", id: "phone_handler", version: "1.2.0", permissions: [], capabilityRequirements: [], lifecycle: {},
      provider: "phone", handlerScript: "./handler.ts", context: "channel_only", inboundEvents: ["message.received", "call.received", "call.digits"],
      outboundEvents: ["message.reply", "voice.reply"] },
  ] },
}, { gatekeeperCapabilities: ["extension.project_canvas", "assistant.phone.read", "assistant.phone.simulate"] });

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function harness(activePublisher = true, artifactSource = html, microAppStatus = 201) {
  const artifactSha256 = "pending";
  const release = {
    extension_id: "ext_customer_voice", version: "1.2.0", manifest, manifest_json: JSON.stringify(manifest),
    artifact_sha256: artifactSha256, publisher: { id: "pub_voice", key_id: "a".repeat(64), signature: "signed-payload", payload_sha256: "b".repeat(64) },
  };
  const spaceRequests: Request[] = [], microAppRequests: Request[] = [], installedRows: Array<Record<string, unknown>> = [];
  const spaceStub = { fetch: vi.fn(async (request: Request) => {
    spaceRequests.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/extension-package-catalog") return Response.json({ releases: [{ extension_id: release.extension_id, version: release.version,
      has_canvas: true, name: "voice_dashboard", requested_shared_filesystem: [], publisher: { id: "pub_voice", key_id: "a".repeat(64) } }] });
    if (path === "/extension-package-release") return Response.json({ release });
    if (path === "/extension-installations") return Response.json({ installations: installedRows.filter(row => row.status !== "removed") });
    if (path === "/extensions") {
      const body = await request.clone().json() as { manifest: unknown; instanceKey: string; scope: string };
      installedRows.push({ instance_id: "install-voice", extension_id: release.extension_id, instance_key: body.instanceKey,
        scope: body.scope, status: "staging", release_version: release.version, manifest: body.manifest });
      return Response.json({ installationId: "install-voice", release: {
        version: release.version, artifactSha256: release.artifact_sha256,
        hostSignature: await signHmac(JSON.stringify([release.extension_id, release.version, release.manifest_json, release.artifact_sha256]), secret),
      } }, { status: 201 });
    }
    if (path === "/extension-installation/activate") {
      installedRows[0]!.status = "active";
      return Response.json({ activated: true, status: "active" });
    }
    if (path === "/extension-installation/abort") {
      installedRows[0]!.status = "removed";
      return Response.json({ aborted: true });
    }
    return Response.json({ error_code: "unexpected_space_do_route" }, { status: 404 });
  }) };
  const microAppStub = { fetch: vi.fn(async (request: Request) => {
    microAppRequests.push(request);
    return Response.json({ initialized: true }, { status: microAppStatus });
  }) };
  const db = { prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({
    first: async () => sql.includes("FROM spaces WHERE id")
      ? { name: "Workspace", spacetype_id: "space", config_json: "{}" }
      : sql.includes("FROM extension_publisher_keys") && activePublisher
        ? { publisher_id: "pub_voice", key_id: "a".repeat(64), active: 1 } : null,
    all: async () => ({ results: activePublisher ? [{ publisher_id: "pub_voice", key_id: "a".repeat(64) }] : [] }),
  }) }) };
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: db,
    SPACE_DO: { idFromName: () => "space-do-id", get: () => spaceStub },
    MICRO_APP_DO: { idFromName: () => "micro-app-id", get: () => microAppStub },
    SCRIPTS_R2: { get: async (key: string) => key.endsWith("/dashboard.html") ? {
      size: new TextEncoder().encode(artifactSource).byteLength,
      arrayBuffer: async () => new TextEncoder().encode(artifactSource).buffer,
    } : key.endsWith("/handler.ts") ? {
      size: new TextEncoder().encode(handler).byteLength,
      arrayBuffer: async () => new TextEncoder().encode(handler).buffer,
    } : null },
    AGENTS_WORKER: { fetch: async () => Response.json({ valid: true }) },
  } as never;
  return { env, spaceRequests, microAppRequests, spaceStub, microAppStub, release };
}

async function signedRequest(path: string, method = "GET", body?: unknown, role = "owner") {
  return new Request(`https://spaces.test${path}`, {
    method,
    headers: { "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"), "x-naelao-tenant-id": "tenant-a",
      "x-naelao-user-id": "owner-a", "x-naelao-role": role, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function updateReviewHarness(options: { activePublisher?: boolean; signatureValid?: boolean } = {}) {
  const old = structuredClone(manifest);
  old.bundle!.version = "1.0.0";
  for (const primitive of old.bundle!.primitives) primitive.version = "1.0.0";
  old.declaredPermissions = old.declaredPermissions.filter(permission => permission !== "assistant.phone.simulate");
  old.capabilityRequirements = old.capabilityRequirements.filter(capability => capability !== "assistant.phone.simulate");
  const oldManifest = validateExtensionManifest(old);
  const candidateManifest = validateExtensionManifest({ ...manifest, bundle: { ...manifest.bundle!, primitives: [...manifest.bundle!.primitives,
    { schemaVersion: "1.0", kind: "gadget", id: "usage_stats", version: "1.2.0", permissions: [], capabilityRequirements: [], lifecycle: {},
      scope: "SPACE_SHARED", schemaSql: "CREATE TABLE usage_stats (id TEXT PRIMARY KEY);", migrations: [] }] } });
  const artifacts = { "./dashboard.html": html, "./handler.ts": handler };
  const artifactEntries = Object.entries(artifacts).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const artifactSha256 = await digest(JSON.stringify(artifactEntries));
  const keyPair = await generateExtensionPublisherKeyPair();
  const publicKey = await exportExtensionPublisherPublicKey(keyPair.publicKey);
  const signature = await signExtensionPublisherRelease({ privateKey: keyPair.privateKey, publicKey: keyPair.publicKey,
    manifestJson: JSON.stringify(candidateManifest), artifacts });
  const publisherPayloadSha256 = await digest(extensionPublisherSigningPayload(JSON.stringify(candidateManifest), artifacts));
  const candidateRelease = { extension_id: candidateManifest.id, version: candidateManifest.bundle!.version, manifest: candidateManifest, manifest_json: JSON.stringify(candidateManifest), artifact_sha256: artifactSha256,
    publisher: { id: "pub_voice", key_id: signature.keyId, signature: options.signatureValid === false ? "invalid" : signature.signature,
      payload_sha256: publisherPayloadSha256 } };
  const spaceRequests: Request[] = [], microAppRequests: Request[] = [];
  const spaceStub = { fetch: vi.fn(async (request: Request) => {
    spaceRequests.push(request);
    const url = new URL(request.url), path = url.pathname;
    if (path === "/extension-installations") {
      if (url.searchParams.get("space_id") !== "space-a") return Response.json({ installations: [] });
      return Response.json({ installations: [{ instance_id: "install-voice", extension_id: manifest.id, project_id: null, scope: "SPACE_SHARED",
        instance_key: "default", status: "active", release_version: "1.0.0", publisher_id: "pub_voice", publisher_key_id: "c".repeat(64), publisher_attestation_valid: true,
        manifest: oldManifest }] });
    }
    if (path === "/extension-package-catalog") return Response.json({ releases: [{ extension_id: candidateManifest.id, version: candidateManifest.bundle!.version }] });
    if (path === "/extension-package-release") return Response.json({ release: candidateRelease });
    return Response.json({ error_code: "unexpected_space_do_route" }, { status: 404 });
  }) };
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({
      first: async () => sql.includes("FROM spaces WHERE id") ? { name: "Workspace", spacetype_id: "space", config_json: "{}" }
        : sql.includes("FROM extension_publisher_keys") && options.activePublisher !== false
          ? { publisher_id: "pub_voice", public_key_b64url: publicKey } : null,
      all: async () => ({ results: [] }),
    }) }) },
    SPACE_DO: { idFromName: () => "space-do-id", get: () => spaceStub },
    MICRO_APP_DO: { idFromName: () => "micro-app-id", get: (_actor: unknown) => ({ fetch: async (request: Request) => { microAppRequests.push(request); return Response.json({ ok: true }); } }) },
    SCRIPTS_R2: { get: async (key: string) => {
      const path = key.endsWith("/dashboard.html") ? "./dashboard.html" : key.endsWith("/handler.ts") ? "./handler.ts" : "";
      if (!path) return null;
      const source = artifacts[path]!;
      const bytes = new TextEncoder().encode(source);
      return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
    } },
  } as never;
  return { env, spaceRequests, microAppRequests, candidateRelease };
}

describe("signed Space-shared extension packages", () => {
  it("lists a trusted package, stages its exact artifact and activates its signed shared dashboard", async () => {
    const h = harness();
    h.release.artifact_sha256 = await digest(JSON.stringify([["./dashboard.html", html], ["./handler.ts", handler]]));
    const path = "/spaces/space-a/shared-extension-catalog";
    const catalog = await spacesWorker.fetch(await signedRequest(path), h.env);
    const catalogBody = await catalog.json() as { extensions: unknown[] };
    expect(catalogBody.extensions).toContainEqual(expect.objectContaining({ id: "ext_customer_voice", version: "1.2.0", publisher_id: "pub_voice" }));

    const installed = await spacesWorker.fetch(await signedRequest(`${path.replace("shared-extension-catalog", "shared-extensions/ext_customer_voice/install")}`,
      "POST", { version: "1.2.0" }), h.env);
    expect(installed.status, JSON.stringify(await installed.clone().json())).toBe(201);
    expect(await installed.json()).toMatchObject({ extension_id: "ext_customer_voice", installation_id: "install-voice", scope: "SPACE_SHARED" });
    const stage = h.spaceRequests.find(request => new URL(request.url).pathname === "/extensions");
    expect(await stage?.clone().json()).toMatchObject({ scope: "SPACE_SHARED", deferActivation: true,
      publisherId: "pub_voice", publisherKeyId: "a".repeat(64), publisherSignature: "signed-payload", artifactSha256: h.release.artifact_sha256,
      gatekeeperCapabilities: ["extension.project_canvas", "assistant.phone.read", "assistant.phone.simulate"] });
    expect(h.microAppRequests).toHaveLength(1);
    expect(await h.microAppRequests[0]!.clone().json()).toMatchObject({ appId: "voice_dashboard", scope: "SPACE_SHARED", gadgetTier: 3,
      html, releaseProof: { extensionId: "ext_customer_voice", version: "1.2.0", canvasPath: "./dashboard.html" } });
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/extension-installation/activate"
      && request.method === "POST")).toBe(true);
    const repeated = await spacesWorker.fetch(await signedRequest("/spaces/space-a/shared-extensions/ext_customer_voice/install", "POST", { version: "1.2.0" }), h.env);
    expect(repeated.status).toBe(201);
    expect(await repeated.json()).toMatchObject({ installation_id: "install-voice" });
    expect(h.microAppRequests).toHaveLength(1);
  });

  it("hides and refuses a package after its configured publisher key is revoked", async () => {
    const h = harness(false);
    h.release.artifact_sha256 = await digest(JSON.stringify([["./dashboard.html", html], ["./handler.ts", handler]]));
    const path = "/spaces/space-a/shared-extension-catalog";
    const catalog = await spacesWorker.fetch(await signedRequest(path), h.env);
    const catalogBody = await catalog.json() as { extensions: Array<{ id: string }> };
    expect(catalogBody.extensions.some(entry => entry.id === "ext_customer_voice")).toBe(false);
    const install = await spacesWorker.fetch(await signedRequest("/spaces/space-a/shared-extensions/ext_customer_voice/install", "POST", { version: "1.2.0" }), h.env);
    expect(install.status, JSON.stringify(await install.clone().json())).toBe(403);
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/extensions")).toBe(false);
    expect(h.microAppRequests).toHaveLength(0);
  });

  it("requires Space admin authority and rejects changed artifact bytes before staging", async () => {
    const h = harness();
    h.release.artifact_sha256 = await digest(JSON.stringify([["./dashboard.html", html], ["./handler.ts", handler]]));
    const path = "/spaces/space-a/shared-extensions/ext_customer_voice/install";
    const unauthorized = await spacesWorker.fetch(await signedRequest(path, "POST", { version: "1.2.0" }, "product_end_user"), h.env);
    expect(unauthorized.status).toBe(403);
    expect(h.spaceRequests).toHaveLength(0);

    const tampered = harness(true, "<main>changed</main>");
    tampered.release.artifact_sha256 = await digest(JSON.stringify([["./dashboard.html", html], ["./handler.ts", handler]]));
    const response = await spacesWorker.fetch(await signedRequest(path, "POST", { version: "1.2.0" }), tampered.env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "extension_package_artifact_digest_mismatch" });
    expect(tampered.spaceRequests.some(request => new URL(request.url).pathname === "/extensions")).toBe(false);
    expect(tampered.microAppRequests).toHaveLength(0);
  });

  it("aborts a staged installation when signed microapp initialization fails", async () => {
    const h = harness(true, html, 500);
    h.release.artifact_sha256 = await digest(JSON.stringify([["./dashboard.html", html], ["./handler.ts", handler]]));
    const response = await spacesWorker.fetch(await signedRequest("/spaces/space-a/shared-extensions/ext_customer_voice/install", "POST", { version: "1.2.0" }), h.env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "extension_package_canvas_initialization_failed" });
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/extension-installation/abort")).toBe(true);
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/extension-installation/activate")).toBe(false);
  });

  it("fails closed when a signed package dependency is not installed at its exact pin", async () => {
    const h = harness();
    h.release.artifact_sha256 = await digest(JSON.stringify([["./dashboard.html", html], ["./handler.ts", handler]]));
    h.release.manifest = validateExtensionManifest({ ...h.release.manifest, dependencies: [
      { extensionId: "ext_shared_calendar", version: "2.0.0", manifestSha256: "c".repeat(64) },
    ] });
    h.release.manifest_json = JSON.stringify(h.release.manifest);
    const response = await spacesWorker.fetch(await signedRequest("/spaces/space-a/shared-extensions/ext_customer_voice/install", "POST", { version: "1.2.0" }), h.env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "extension_package_dependency_unresolved" });
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/extensions")).toBe(false);
    expect(h.microAppRequests).toHaveLength(0);
  });
});

describe("signed Space-shared package update review", () => {
  const path = "/spaces/space-a/shared-extension-installations/install-voice/update-review";

  it("previews the exact pinned install and verifies the candidate signature without mutating it", async () => {
    const h = await updateReviewHarness();
    const response = await spacesWorker.fetch(await signedRequest(path, "POST", { expected_current_version: "1.0.0", candidate_version: "1.2.0" }), h.env);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(await response.json()).toMatchObject({ current: { version: "1.0.0" }, candidate: { version: "1.2.0", signature_verified: true },
      permissions: { added: ["assistant.phone.simulate"] }, capabilities: { added: ["assistant.phone.simulate"] },
      schema_changes: { added: ["gadget:usage_stats"] },
      dependencies: { package: { status: "resolved", candidate_pins: [] } },
      price_terms: { current: null, candidate: null }, review: { authority_expanded: true, explicit_owner_approval_required: true,
        mutates_installation: false, apply_supported: false } });
    expect(h.spaceRequests.every(request => request.method === "GET")).toBe(true);
    expect(h.microAppRequests).toHaveLength(0);
  });

  it("rejects stale pins, a different Space installation, revoked keys, and invalid publisher signatures", async () => {
    const stale = await updateReviewHarness();
    const staleResponse = await spacesWorker.fetch(await signedRequest(path, "POST", { expected_current_version: "0.9.0", candidate_version: "1.2.0" }), stale.env);
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({ error_code: "extension_update_review_stale_pin", current_version: "1.0.0" });

    const wrongSpace = await updateReviewHarness();
    const wrongSpaceResponse = await spacesWorker.fetch(await signedRequest(path.replace("space-a", "space-b"), "POST",
      { expected_current_version: "1.0.0", candidate_version: "1.2.0" }), wrongSpace.env);
    expect(wrongSpaceResponse.status).toBe(404);

    const revoked = await updateReviewHarness({ activePublisher: false });
    const revokedResponse = await spacesWorker.fetch(await signedRequest(path, "POST", { expected_current_version: "1.0.0", candidate_version: "1.2.0" }), revoked.env);
    expect(revokedResponse.status).toBe(403);
    expect(await revokedResponse.json()).toMatchObject({ error_code: "extension_publisher_key_untrusted_or_revoked" });

    const invalid = await updateReviewHarness({ signatureValid: false });
    const invalidResponse = await spacesWorker.fetch(await signedRequest(path, "POST", { expected_current_version: "1.0.0", candidate_version: "1.2.0" }), invalid.env);
    expect(invalidResponse.status).toBe(409);
    expect(await invalidResponse.json()).toMatchObject({ error_code: "extension_update_review_candidate_invalid", reason: "publisher_signature_invalid" });
  });

  it("requires Space admin authority and rejects candidates outside the current package catalog", async () => {
    const unauthorized = await updateReviewHarness();
    const denied = await spacesWorker.fetch(await signedRequest(path, "POST", { expected_current_version: "1.0.0", candidate_version: "1.2.0" }, "product_end_user"), unauthorized.env);
    expect(denied.status).toBe(403);
    expect(unauthorized.spaceRequests).toHaveLength(0);

    const h = await updateReviewHarness();
    const wrongCandidate = await spacesWorker.fetch(await signedRequest(path, "POST", { expected_current_version: "1.0.0", candidate_version: "2.0.0" }), h.env);
    expect(wrongCandidate.status).toBe(409);
    expect(await wrongCandidate.json()).toMatchObject({ error_code: "extension_update_review_candidate_not_current" });
    expect(h.spaceRequests.every(request => request.method === "GET")).toBe(true);
  });
});
