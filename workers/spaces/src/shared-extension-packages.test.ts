import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { signHmac } from "@naelao/crypto";
import { validateExtensionManifest } from "@naelao/agent-sdk";
import spacesWorker from "./index.js";

const secret = "shared-extension-package-route-secret";
const html = "<main>Customer dashboard</main>";
const manifest = validateExtensionManifest({
  id: "ext_customer_voice", type: "extension", declaredPermissions: [], capabilityRequirements: ["extension.project_canvas"],
  gadgets: [], daemons: [], commands: [],
  bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_customer_voice", version: "1.2.0", primitives: [
    { schemaVersion: "1.0", kind: "canvas", id: "voice_dashboard", version: "1.2.0", permissions: [], capabilityRequirements: [], lifecycle: {},
      component: "./dashboard.html", layout: "CanvasMount", dynamicPage: false },
  ] },
}, { gatekeeperCapabilities: ["extension.project_canvas"] });

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
    } : null },
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

describe("signed Space-shared extension packages", () => {
  it("lists a trusted package, stages its exact artifact and activates its signed shared dashboard", async () => {
    const h = harness();
    h.release.artifact_sha256 = await digest(JSON.stringify([["./dashboard.html", html]]));
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
      publisherId: "pub_voice", publisherKeyId: "a".repeat(64), publisherSignature: "signed-payload", artifactSha256: h.release.artifact_sha256 });
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
    h.release.artifact_sha256 = await digest(JSON.stringify([["./dashboard.html", html]]));
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
    h.release.artifact_sha256 = await digest(JSON.stringify([["./dashboard.html", html]]));
    const path = "/spaces/space-a/shared-extensions/ext_customer_voice/install";
    const unauthorized = await spacesWorker.fetch(await signedRequest(path, "POST", { version: "1.2.0" }, "product_end_user"), h.env);
    expect(unauthorized.status).toBe(403);
    expect(h.spaceRequests).toHaveLength(0);

    const tampered = harness(true, "<main>changed</main>");
    tampered.release.artifact_sha256 = await digest(JSON.stringify([["./dashboard.html", html]]));
    const response = await spacesWorker.fetch(await signedRequest(path, "POST", { version: "1.2.0" }), tampered.env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "extension_package_artifact_digest_mismatch" });
    expect(tampered.spaceRequests.some(request => new URL(request.url).pathname === "/extensions")).toBe(false);
    expect(tampered.microAppRequests).toHaveLength(0);
  });

  it("aborts a staged installation when signed microapp initialization fails", async () => {
    const h = harness(true, html, 500);
    h.release.artifact_sha256 = await digest(JSON.stringify([["./dashboard.html", html]]));
    const response = await spacesWorker.fetch(await signedRequest("/spaces/space-a/shared-extensions/ext_customer_voice/install", "POST", { version: "1.2.0" }), h.env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "extension_package_canvas_initialization_failed" });
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/extension-installation/abort")).toBe(true);
    expect(h.spaceRequests.some(request => new URL(request.url).pathname === "/extension-installation/activate")).toBe(false);
  });
});
