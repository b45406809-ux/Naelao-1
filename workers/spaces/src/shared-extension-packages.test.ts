import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { signHmac } from "@naelao/crypto";
import { digestExtensionManifest, exportExtensionPublisherPublicKey, extensionPublisherSigningPayload, generateExtensionPublisherKeyPair,
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
      const body = await request.clone().json() as { manifest: unknown; instanceKey: string; scope: string; approvedSharedFilesystem?: unknown[] };
      const prior = installedRows.find(row => row.instance_id === "install-voice");
      if (prior) Object.assign(prior, { status: "staging", release_version: release.version, manifest: body.manifest,
        approvedSharedFilesystem: body.approvedSharedFilesystem });
      else installedRows.push({ instance_id: "install-voice", extension_id: release.extension_id, instance_key: body.instanceKey,
        scope: body.scope, status: "staging", release_version: release.version, manifest: body.manifest,
        approvedSharedFilesystem: body.approvedSharedFilesystem });
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
  return { env, spaceRequests, microAppRequests, spaceStub, microAppStub, release, installedRows };
}

async function signedRequest(path: string, method = "GET", body?: unknown, role = "owner") {
  return new Request(`https://spaces.test${path}`, {
    method,
    headers: { "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"), "x-naelao-tenant-id": "tenant-a",
      "x-naelao-user-id": "owner-a", "x-naelao-role": role, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function updateReviewHarness(options: { activePublisher?: boolean; signatureValid?: boolean; passive?: boolean; installationStatus?: "active" | "disabled";
  activeWorkCount?: number } = {}) {
  const passiveManifest = (version: string) => validateExtensionManifest({ id: "ext_customer_voice", type: "extension", declaredPermissions: [], capabilityRequirements: ["extension.project_canvas"],
    gadgets: [], daemons: [], commands: [], bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_customer_voice", version,
      primitives: [
        { schemaVersion: "1.0", kind: "canvas", id: "voice_dashboard", version, permissions: [], capabilityRequirements: [], lifecycle: {},
          component: "./dashboard.html", layout: "CanvasMount", dynamicPage: false },
        { schemaVersion: "1.0", kind: "channel", id: "phone_handler", version, permissions: [], capabilityRequirements: [], lifecycle: {},
          provider: "phone", handlerScript: "./handler.ts", context: "channel_only", inboundEvents: ["message.received", "call.received", "call.digits"], outboundEvents: ["message.reply", "voice.reply"] },
      ] } }, { gatekeeperCapabilities: ["extension.project_canvas"] });
  const old = options.passive ? passiveManifest("1.0.0") : structuredClone(manifest);
  if (!options.passive) {
    old.bundle!.version = "1.0.0";
    for (const primitive of old.bundle!.primitives) primitive.version = "1.0.0";
    old.declaredPermissions = old.declaredPermissions.filter(permission => permission !== "assistant.phone.simulate");
    old.capabilityRequirements = old.capabilityRequirements.filter(capability => capability !== "assistant.phone.simulate");
  }
  const oldManifest = validateExtensionManifest(old);
  const candidateManifest = options.passive ? passiveManifest("1.2.0") : validateExtensionManifest({ ...manifest, bundle: { ...manifest.bundle!, primitives: [...manifest.bundle!.primitives,
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
    if (path === "/extension-runtime-work") return Response.json({ active_work_count: options.activeWorkCount ?? 0, drained: (options.activeWorkCount ?? 0) === 0 });
    if (path === "/extension-installations") {
      if (url.searchParams.get("space_id") !== "space-a") return Response.json({ installations: [] });
      return Response.json({ installations: [{ instance_id: "install-voice", extension_id: manifest.id, project_id: null, scope: "SPACE_SHARED",
        instance_key: "default", status: options.installationStatus ?? "active", release_version: "1.0.0", publisher_id: "pub_voice",
        publisher_key_id: options.passive ? signature.keyId : "c".repeat(64), publisher_attestation_valid: true,
        manifest: oldManifest }] });
    }
    if (path === "/extension-package-catalog") return Response.json({ releases: [{ extension_id: candidateManifest.id, version: candidateManifest.bundle!.version }] });
    if (path === "/extension-package-release") return Response.json({ release: candidateRelease });
    if (path === "/space-shared-extension-updates") return Response.json({ receipts: [] });
    if (path === "/space-shared-extension-update") {
      const body = await request.clone().json() as { actorId: string; claims: { requestId: string; installationId: string; extensionId: string;
        fromVersion: string; toVersion: string; artifactSha256: string; publisherKeyId: string } };
      return Response.json({ updated: true, replayed: false, receipt: { request_id: body.claims.requestId, tenant_id: "tenant-a", space_id: "space-a",
        installation_id: body.claims.installationId, extension_id: body.claims.extensionId, from_version: body.claims.fromVersion,
        to_version: body.claims.toVersion, artifact_sha256: body.claims.artifactSha256, publisher_key_id: body.claims.publisherKeyId,
        actor_id: body.actorId, created_at: new Date().toISOString() } });
    }
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

async function installReviewHarness(options: { failNextRootInitialization?: boolean } = {}) {
  const dependencyManifest = validateExtensionManifest({ ...manifest, id: "ext_calendar", channels: undefined, bundle: { ...manifest.bundle!, id: "ext_calendar", version: "1.0.0",
    primitives: manifest.bundle!.primitives.map((primitive, index) => ({ ...primitive, id: index === 0 ? "calendar_dashboard" : "calendar_handler", version: "1.0.0" })) } });
  const dependencyDigest = await digestExtensionManifest(dependencyManifest);
  const rootManifest = validateExtensionManifest({ ...manifest, dependencies: [{ extensionId: "ext_calendar", version: "1.0.0", manifestSha256: dependencyDigest }] });
  const keyPair = await generateExtensionPublisherKeyPair();
  const publicKey = await exportExtensionPublisherPublicKey(keyPair.publicKey);
  const artifacts = { "./dashboard.html": html, "./handler.ts": handler };
  const makeRelease = async (packageManifest: typeof manifest) => {
    const manifestJson = JSON.stringify(packageManifest);
    const entries = Object.entries(artifacts).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const signature = await signExtensionPublisherRelease({ privateKey: keyPair.privateKey, publicKey: keyPair.publicKey, manifestJson, artifacts });
    return { extension_id: packageManifest.id, version: packageManifest.bundle!.version, manifest: packageManifest, manifest_json: manifestJson,
      artifact_sha256: await digest(JSON.stringify(entries)), publisher: { id: "pub_voice", key_id: signature.keyId, signature: signature.signature,
        payload_sha256: await digest(extensionPublisherSigningPayload(manifestJson, artifacts)) } };
  };
  const releases = new Map<string, Awaited<ReturnType<typeof makeRelease>>>();
  const rootRelease = await makeRelease(rootManifest), dependencyRelease = await makeRelease(dependencyManifest);
  releases.set(`${rootRelease.extension_id}@${rootRelease.version}`, rootRelease);
  releases.set(`${dependencyRelease.extension_id}@${dependencyRelease.version}`, dependencyRelease);
  const objects = new Map<string, string>();
  for (const release of releases.values()) for (const [path, source] of Object.entries(artifacts))
    objects.set(`spaces/space-a/extensions/${release.extension_id}/${release.version}/${path.slice(2)}`, source);
  const spaceRequests: Request[] = [], microAppRequests: Request[] = [];
  const installedRows: Array<Record<string, unknown>> = [];
  const spaceStub = { fetch: vi.fn(async (request: Request) => {
    spaceRequests.push(request);
    const url = new URL(request.url), path = url.pathname;
    if (path === "/extension-package-release") {
      const release = releases.get(`${url.searchParams.get("extension_id")}@${url.searchParams.get("version")}`);
      return release ? Response.json({ release }) : Response.json({ error_code: "not_found" }, { status: 404 });
    }
    if (path === "/extension-installations") return Response.json({ installations: installedRows.filter(row => row.status !== "removed") });
    if (path === "/extensions") {
      const body = await request.clone().json() as { manifest: typeof manifest; instanceKey: string; scope: string };
      const release = releases.get(`${body.manifest.id}@${body.manifest.bundle?.version}`)!;
      const instanceId = body.manifest.id === "ext_customer_voice" ? "install-root" : "install-calendar";
      const row = installedRows.find(item => item.instance_id === instanceId);
      const staged = { instance_id: instanceId, extension_id: body.manifest.id, instance_key: body.instanceKey, project_id: null,
        scope: body.scope, status: "staging", release_version: release.version, manifest_sha256: await digestExtensionManifest(body.manifest),
        publisher_key_id: release.publisher.key_id, publisher_attestation_valid: true, manifest: body.manifest,
        activation_summary: { approved_shared_filesystem: [] } };
      if (row) Object.assign(row, staged); else installedRows.push(staged);
      return Response.json({ installationId: instanceId, release: { version: release.version, artifactSha256: release.artifact_sha256,
        hostSignature: await signHmac(JSON.stringify([release.extension_id, release.version, release.manifest_json, release.artifact_sha256]), secret) } }, { status: 201 });
    }
    if (path === "/extension-installation/activate" || path === "/extension-installation/abort") {
      const body = await request.clone().json() as { installationId: string };
      const row = installedRows.find(item => item.instance_id === body.installationId);
      if (row) row.status = path.endsWith("/activate") ? "active" : "removed";
      return Response.json({ activated: path.endsWith("/activate"), aborted: path.endsWith("/abort") });
    }
    return Response.json({ error_code: "unexpected_space_do_route" }, { status: 404 });
  }) };
  let failNextRootInitialization = options.failNextRootInitialization === true;
  const microAppStub = { fetch: vi.fn(async (request: Request) => {
    microAppRequests.push(request);
    const body = await request.clone().json() as { appId?: string };
    if (failNextRootInitialization && body.appId === "voice_dashboard") { failNextRootInitialization = false; return Response.json({ initialized: false }, { status: 500 }); }
    return Response.json({ initialized: true });
  }) };
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare: (sql: string) => ({ bind: (..._params: unknown[]) => ({
      first: async () => sql.includes("FROM spaces WHERE id") ? { name: "Workspace", spacetype_id: "space", config_json: "{}" }
        : sql.includes("FROM extension_publisher_keys") ? { publisher_id: "pub_voice", public_key_b64url: publicKey, key_id: rootRelease.publisher.key_id } : null,
      all: async () => ({ results: [{ key_id: rootRelease.publisher.key_id, publisher_id: "pub_voice" }] }),
    }) }) },
    SPACE_DO: { idFromName: () => "space-do-id", get: () => spaceStub },
    MICRO_APP_DO: { idFromName: () => "micro-app-id", get: () => microAppStub },
    SCRIPTS_R2: { get: async (key: string) => { const source = objects.get(key); if (source === undefined) return null; const bytes = new TextEncoder().encode(source);
      return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }; } },
  } as never;
  return { env, spaceRequests, microAppRequests, installedRows, rootRelease, dependencyRelease, dependencyManifest, dependencyDigest, rootManifest };
}

async function crossSpaceImportHarness(options: { destinationTrust?: boolean; sourceRole?: string } = {}) {
  const dependencyManifest = validateExtensionManifest({ ...manifest, id: "ext_calendar", channels: undefined,
    bundle: { ...manifest.bundle!, id: "ext_calendar", version: "1.0.0", primitives: manifest.bundle!.primitives.map((primitive, index) => ({
      ...primitive, id: index === 0 ? "calendar_dashboard" : "calendar_handler", version: "1.0.0" })) } });
  const dependencyDigest = await digestExtensionManifest(dependencyManifest);
  const rootManifest = validateExtensionManifest({ ...manifest, dependencies: [{ extensionId: "ext_calendar", version: "1.0.0", manifestSha256: dependencyDigest }] });
  const keyPair = await generateExtensionPublisherKeyPair();
  const publicKey = await exportExtensionPublisherPublicKey(keyPair.publicKey);
  const artifacts = { "./dashboard.html": html, "./handler.ts": handler };
  const makeRelease = async (packageManifest: ReturnType<typeof validateExtensionManifest>) => {
    const manifestJson = JSON.stringify(packageManifest);
    const entries = Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right));
    const publisherSignature = await signExtensionPublisherRelease({ privateKey: keyPair.privateKey, publicKey: keyPair.publicKey, manifestJson, artifacts });
    return { extension_id: packageManifest.id, version: packageManifest.bundle!.version, manifest: packageManifest, manifest_json: manifestJson,
      artifact_sha256: await digest(JSON.stringify(entries)), publisher: { id: "pub_voice", key_id: publisherSignature.keyId,
        signature: publisherSignature.signature, payload_sha256: await digest(extensionPublisherSigningPayload(manifestJson, artifacts)) } };
  };
  const releases = new Map<string, Awaited<ReturnType<typeof makeRelease>>>();
  const dependencyRelease = await makeRelease(dependencyManifest), rootRelease = await makeRelease(rootManifest);
  releases.set(`${dependencyRelease.extension_id}@${dependencyRelease.version}`, dependencyRelease);
  releases.set(`${rootRelease.extension_id}@${rootRelease.version}`, rootRelease);
  const objects = new Map<string, Uint8Array>();
  for (const release of releases.values()) for (const [path, source] of Object.entries(artifacts))
    objects.set(`spaces/source/extensions/${release.extension_id}/${release.version}/${path.slice(2)}`, new TextEncoder().encode(source));
  const destinationReleases = new Map<string, string>();
  const sourceStub = { fetch: vi.fn(async (request: Request) => {
    const url = new URL(request.url), release = releases.get(`${url.searchParams.get("extension_id")}@${url.searchParams.get("version")}`);
    return release ? Response.json({ release }) : Response.json({ error_code: "not_found" }, { status: 404 });
  }) };
  const destinationStub = { fetch: vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname !== "/extension-package-release/import") return Response.json({ error_code: "unexpected_route" }, { status: 404 });
    const body = await request.clone().json() as { extensionId: string; version: string; manifestJson: string };
    const key = `${body.extensionId}@${body.version}`;
    const prior = destinationReleases.get(key);
    if (prior && prior !== body.manifestJson) return Response.json({ error_code: "extension_package_release_immutable_conflict" }, { status: 409 });
    const imported = !prior;
    destinationReleases.set(key, body.manifestJson);
    return Response.json({ imported, extension_id: body.extensionId, version: body.version });
  }) };
  const tenants = new Map([["source", "tenant-a"], ["destination", "tenant-a"]]);
  const trusted = new Set(["source"]);
  if (options.destinationTrust !== false) trusted.add("destination");
  const roles = new Map([["source", options.sourceRole ?? "admin"], ["destination", "admin"]]);
  let failRootArtifactOnce = true;
  const db = { prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({
    first: async () => {
      if (sql.includes("FROM spaces WHERE id")) return tenants.get(String(params[0])) === params[1]
        ? { name: String(params[0]), spacetype_id: "space", config_json: "{}" } : null;
      if (sql.includes("JOIN space_members")) return roles.get(String(params[0])) ? { role: roles.get(String(params[0])) } : null;
      if (sql.includes("FROM extension_publisher_keys")) return trusted.has(String(params[1]))
        ? { publisher_id: "pub_voice", public_key_b64url: publicKey } : null;
      return null;
    }, all: async () => ({ results: [] }),
  }) }) };
  const bucket = {
    get: async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) return null;
      const copy = bytes.slice();
      return { size: copy.byteLength, arrayBuffer: async () => copy.buffer };
    },
    put: async (key: string, value: Uint8Array) => {
      if (key.includes(`/${rootManifest.id}/`) && key.endsWith("/handler.ts") && failRootArtifactOnce) {
        failRootArtifactOnce = false;
        return null;
      }
      if (objects.has(key)) return null;
      objects.set(key, value.slice());
      return { key };
    },
  };
  const spaceRequests: Request[] = [];
  const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db,
    SPACE_DO: { idFromName: (name: string) => name, get: (id: string) => id.endsWith(":space:source") ? sourceStub : destinationStub },
    SCRIPTS_R2: bucket } as never;
  return { env, objects, destinationReleases, spaceRequests, rootManifest, dependencyManifest, rootRelease, dependencyRelease };
}

describe("signed Space-shared extension packages", () => {
  it("reviews every exact dependency and requires a fresh owner receipt before installation", async () => {
    const h = await installReviewHarness({ failNextRootInitialization: true });
    const reviewPath = "/spaces/space-a/shared-extensions/ext_customer_voice/install-review";
    const review = async () => spacesWorker.fetch(await signedRequest(reviewPath, "POST", { version: "1.2.0", approved_shared_filesystem: [] }), h.env);
    const missing = await review();
    expect(missing.status).toBe(200);
    const missingBody = await missing.json() as { review_token?: string };
    expect(missingBody).toMatchObject({ mutates_installation: false, ready_to_install: true,
      requested_package: { publisher_signature_verified: true, dependencies: [{ extensionId: "ext_calendar", version: "1.0.0" }] },
      dependency_packages: [{ extension_id: "ext_calendar", version: "1.0.0", publisher_id: "pub_voice", publisher_signature_verified: true,
        publisher_key_id: h.dependencyRelease.publisher.key_id, manifest_sha256: h.dependencyDigest,
        installed_state: "install_required", installable: true, permissions: ["assistant.phone.read", "assistant.phone.simulate"] }] });
    expect(missingBody.review_token).toBeTruthy();
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/extensions")).toBe(false);
    expect(h.microAppRequests).toHaveLength(0);
    const invalidReceipt = await spacesWorker.fetch(await signedRequest("/spaces/space-a/shared-extensions/ext_customer_voice/install", "POST",
      { version: "1.2.0", dependency_review_token: "invalid" }), h.env);
    expect(invalidReceipt.status).toBe(409);
    expect(await invalidReceipt.json()).toMatchObject({ error_code: "extension_package_dependency_review_required" });
    expect(h.microAppRequests).toHaveLength(0);

    const interrupted = await spacesWorker.fetch(await signedRequest("/spaces/space-a/shared-extensions/ext_customer_voice/install", "POST",
      { version: "1.2.0", dependency_review_token: missingBody.review_token }), h.env);
    expect(interrupted.status).toBe(503);
    expect(await interrupted.json()).toMatchObject({ error_code: "extension_package_canvas_initialization_failed",
      dependency_installations: [{ extensionId: "ext_calendar", installationId: "install-calendar" }] });
    expect(h.installedRows.find(row => row.instance_id === "install-calendar")?.status).toBe("active");
    expect(h.installedRows.find(row => row.instance_id === "install-root")?.status).toBe("removed");
    expect(h.microAppRequests).toHaveLength(2);

    const installed = await spacesWorker.fetch(await signedRequest("/spaces/space-a/shared-extensions/ext_customer_voice/install", "POST",
      { version: "1.2.0", dependency_review_token: missingBody.review_token }), h.env);
    expect(installed.status, JSON.stringify(await installed.clone().json())).toBe(201);
    expect(await installed.json()).toMatchObject({ installation_id: "install-root",
      dependency_installations: [{ extensionId: "ext_calendar", version: "1.0.0", installationId: "install-calendar" }] });
    expect(h.microAppRequests).toHaveLength(3);
    expect(h.installedRows.find(row => row.instance_id === "install-root")?.status).toBe("active");
    expect(h.installedRows.find(row => row.instance_id === "install-calendar")?.status).toBe("active");

    const retried = await spacesWorker.fetch(await signedRequest("/spaces/space-a/shared-extensions/ext_customer_voice/install", "POST",
      { version: "1.2.0", dependency_review_token: missingBody.review_token }), h.env);
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({ installation_id: "install-root" });
    expect(h.microAppRequests).toHaveLength(3);

    h.installedRows.find(row => row.instance_id === "install-calendar")!.status = "disabled";
    const pausedReview = await review();
    expect(pausedReview.status).toBe(200);
    expect(await pausedReview.json()).toMatchObject({ ready_to_install: false,
      dependency_packages: [{ installed_state: "installed_disabled" }] });
    const pausedInstall = await spacesWorker.fetch(await signedRequest("/spaces/space-a/shared-extensions/ext_customer_voice/install", "POST",
      { version: "1.2.0", dependency_review_token: missingBody.review_token }), h.env);
    expect(pausedInstall.status).toBe(409);
    expect(h.microAppRequests).toHaveLength(3);
  });

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

  it("resumes the exact staged pin after a lost install response and preserves prior grants", async () => {
    const h = harness();
    h.release.artifact_sha256 = await digest(JSON.stringify([["./dashboard.html", html], ["./handler.ts", handler]]));
    const priorGrant = { path: "/space/shared/customer-data/", access: "READ" as const };
    h.installedRows.push({ instance_id: "install-voice", extension_id: "ext_customer_voice", project_id: null, scope: "SPACE_SHARED",
      instance_key: "default", status: "staging", release_version: "1.2.0", publisher_key_id: "a".repeat(64),
      publisher_attestation_valid: true, manifest, activation_summary: { approved_shared_filesystem: [priorGrant] } });
    const response = await spacesWorker.fetch(await signedRequest("/spaces/space-a/shared-extensions/ext_customer_voice/install", "POST",
      { version: "1.2.0", approved_shared_filesystem: [] }), h.env);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    expect(await response.json()).toMatchObject({ installation_id: "install-voice" });
    const stage = h.spaceRequests.find(request => new URL(request.url).pathname === "/extensions");
    expect(await stage?.json()).toMatchObject({ approvedSharedFilesystem: [priorGrant], deferActivation: true });
    expect(h.microAppRequests).toHaveLength(1);
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/extension-installation/activate")).toBe(true);
    expect(h.installedRows[0]?.status).toBe("active");
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

  it("issues a short-lived owner token only for a paused static Canvas and channel-code update and applies it through the SpaceDO", async () => {
    const h = await updateReviewHarness({ passive: true, installationStatus: "disabled" });
    const reviewResponse = await spacesWorker.fetch(await signedRequest(path, "POST",
      { expected_current_version: "1.0.0", candidate_version: "1.2.0" }), h.env);
    expect(reviewResponse.status, JSON.stringify(await reviewResponse.clone().json())).toBe(200);
    const review = await reviewResponse.json() as { review: { apply_supported: boolean; apply_block_reason: string | null;
      active_work_count: number; runtime_work_drained: boolean };
      update_review_token?: string; update_review_expires_at?: number; candidate: { artifact_sha256: string } };
    expect(review.review).toMatchObject({ apply_supported: true, apply_block_reason: null, active_work_count: 0, runtime_work_drained: true });
    expect(review.update_review_token).toBeTruthy();
    expect(review.update_review_expires_at).toBeGreaterThan(Date.now());
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/extension-runtime-work" && request.method === "POST")).toBe(true);

    const applyPath = "/spaces/space-a/shared-extension-installations/install-voice/update";
    const applied = await spacesWorker.fetch(await signedRequest(applyPath, "POST", { review_token: review.update_review_token }), h.env);
    expect(applied.status, JSON.stringify(await applied.clone().json())).toBe(200);
    expect(await applied.json()).toMatchObject({ updated: true, replayed: false, receipt: {
      installation_id: "install-voice", extension_id: "ext_customer_voice", from_version: "1.0.0", to_version: "1.2.0",
      artifact_sha256: review.candidate.artifact_sha256, actor_id: "owner-a",
    } });
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/space-shared-extension-update" && request.method === "POST")).toBe(true);
  });

  it("requires pause and drain before issuing an apply token, and rejects packages with runtime authority", async () => {
    const active = await updateReviewHarness({ passive: true, installationStatus: "active", activeWorkCount: 1 });
    const activeReview = await spacesWorker.fetch(await signedRequest(path, "POST",
      { expected_current_version: "1.0.0", candidate_version: "1.2.0" }), active.env);
    expect(await activeReview.json()).toMatchObject({ review: { apply_supported: false, active_work_count: 1,
      runtime_work_drained: false, apply_block_reason: "pause the installation before applying an update" } });

    const busy = await updateReviewHarness({ passive: true, installationStatus: "disabled", activeWorkCount: 2 });
    const busyReview = await spacesWorker.fetch(await signedRequest(path, "POST",
      { expected_current_version: "1.0.0", candidate_version: "1.2.0" }), busy.env);
    expect(await busyReview.json()).toMatchObject({ review: { apply_supported: false, active_work_count: 2,
      runtime_work_drained: false, apply_block_reason: "wait for admitted runtime work to drain" } });

    const runtime = await updateReviewHarness({ installationStatus: "disabled" });
    const runtimeReview = await spacesWorker.fetch(await signedRequest(path, "POST",
      { expected_current_version: "1.0.0", candidate_version: "1.2.0" }), runtime.env);
    expect(await runtimeReview.json()).toMatchObject({ review: { apply_supported: false } });
  });

  it("exposes update receipts only through the Space admin caller", async () => {
    const h = await updateReviewHarness();
    const historyPath = "/spaces/space-a/shared-extension-update-receipts";
    const denied = await spacesWorker.fetch(await signedRequest(historyPath, "GET", undefined, "product_end_user"), h.env);
    expect(denied.status).toBe(403);
    const response = await spacesWorker.fetch(await signedRequest(historyPath), h.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receipts: [] });
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/space-shared-extension-updates"
      && Boolean(request.headers.get("x-naelao-internal-token")))).toBe(true);
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

describe("owner-authorized cross-Space package import", () => {
  const reviewPath = "/spaces/destination/shared-extension-imports/review";
  const importPath = "/spaces/destination/shared-extension-imports";
  const body = { source_space_id: "source", extension_id: "ext_customer_voice", version: "1.2.0" };

  it("reviews without writes, resumes a partial dependency closure, and preserves immutable artifacts", async () => {
    const h = await crossSpaceImportHarness();
    const reviewResponse = await spacesWorker.fetch(await signedRequest(reviewPath, "POST", body), h.env);
    expect(reviewResponse.status, JSON.stringify(await reviewResponse.clone().json())).toBe(200);
    const review = await reviewResponse.json() as { review_token: string; packages: Array<{ extension_id: string }> };
    expect(review.packages.map(item => item.extension_id)).toEqual(["ext_calendar", "ext_customer_voice"]);
    expect(h.destinationReleases.size).toBe(0);
    expect([...h.objects.keys()].every(key => key.startsWith("spaces/source/"))).toBe(true);

    const importBody = { ...body, review_token: review.review_token };
    const interrupted = await spacesWorker.fetch(await signedRequest(importPath, "POST", importBody), h.env);
    expect(interrupted.status).toBe(503);
    expect(await interrupted.json()).toMatchObject({ error_code: "extension_package_destination_artifact_write_conflict", retryable: true,
      completed_packages: [{ extension_id: "ext_calendar", metadata_imported: true }] });
    expect(h.destinationReleases.has("ext_calendar@1.0.0")).toBe(true);
    expect(h.destinationReleases.has("ext_customer_voice@1.2.0")).toBe(false);
    expect(h.objects.has("spaces/destination/extensions/ext_customer_voice/1.2.0/dashboard.html")).toBe(true);
    expect(h.objects.has("spaces/destination/extensions/ext_customer_voice/1.2.0/handler.ts")).toBe(false);

    const resumed = await spacesWorker.fetch(await signedRequest(importPath, "POST", importBody), h.env);
    expect(resumed.status, JSON.stringify(await resumed.clone().json())).toBe(200);
    expect(await resumed.json()).toMatchObject({ imported: true, source_space_id: "source", destination_space_id: "destination",
      next_action: "review_and_install_in_destination", completed_packages: [
        { extension_id: "ext_calendar", version: "1.0.0", copied_artifacts: 0, reused_artifacts: 2, metadata_imported: false },
        { extension_id: "ext_customer_voice", version: "1.2.0", copied_artifacts: 1, reused_artifacts: 1, metadata_imported: true },
      ] });
    expect(h.destinationReleases.size).toBe(2);
    expect([...h.objects.keys()].filter(key => key.startsWith("spaces/destination/")).length).toBe(4);
  });

  it("requires source and destination admin membership and an already trusted destination key", async () => {
    const sourceDenied = await crossSpaceImportHarness({ sourceRole: "member" });
    const memberRequest = await signedRequest(reviewPath, "POST", body, "product_end_user");
    const memberResponse = await spacesWorker.fetch(memberRequest, sourceDenied.env);
    expect(memberResponse.status).toBe(403);
    expect(await memberResponse.json()).toMatchObject({ error_code: "source_and_destination_space_admin_required" });

    const untrusted = await crossSpaceImportHarness({ destinationTrust: false });
    const keyResponse = await spacesWorker.fetch(await signedRequest(reviewPath, "POST", body), untrusted.env);
    expect(keyResponse.status).toBe(403);
    expect(await keyResponse.json()).toMatchObject({ error_code: "extension_package_publisher_key_untrusted_or_revoked" });
    expect(untrusted.destinationReleases.size).toBe(0);
  });

  it("does not expose another tenant's source Space", async () => {
    const h = await crossSpaceImportHarness();
    const request = new Request(`https://spaces.test${reviewPath}`, { method: "POST", headers: {
      "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-b"),
      "x-naelao-tenant-id": "tenant-b", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner",
    }, body: JSON.stringify(body) });
    const response = await spacesWorker.fetch(request, h.env);
    expect(response.status).toBe(404);
    expect(h.destinationReleases.size).toBe(0);
  });
});
