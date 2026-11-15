import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { digestExtensionManifest, validateExtensionManifest } from "@naelao/agent-sdk";
import { signHmac } from "@naelao/crypto";
import { errorResponse, mintInternalToken } from "@naelao/http";
import { registerProductUserMicroAppRoutes } from "./product-user-micro-app.js";

const secret = "product-user-micro-app-test-secret";
const html = "<main>Personal notes</main>";
const handler = "export default async function handle() { return { ok: true }; }";
const manifest = validateExtensionManifest({ id: "ext_user_notes", type: "extension", declaredPermissions: [],
  capabilityRequirements: ["extension.project_canvas"], gadgets: [], daemons: [], commands: [], bundle: {
    schemaVersion: "1.0", kind: "extension_bundle", id: "ext_user_notes", version: "1.0.0", primitives: [
      { schemaVersion: "1.0", kind: "canvas", id: "notes_canvas", version: "1.0.0", permissions: [],
        capabilityRequirements: [], lifecycle: {}, component: "./notes.html", layout: "CanvasMount", dynamicPage: false },
      { schemaVersion: "1.0", kind: "channel", id: "channel_handler", version: "1.0.0", permissions: [],
        capabilityRequirements: [], lifecycle: {}, provider: "phone", handlerScript: "./handler.ts", context: "channel_only",
        inboundEvents: ["message.received"], outboundEvents: ["message.reply"] },
      { schemaVersion: "1.0", kind: "gadget", id: "personal_notes", version: "1.0.0", scope: "SPACE_USER",
        permissions: [], capabilityRequirements: [], lifecycle: {}, schemaSql: "CREATE TABLE notes(id TEXT PRIMARY KEY,body TEXT NOT NULL)" },
    ],
  },
}, { gatekeeperCapabilities: ["extension.project_canvas"] });

async function digest(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function harness() {
  const manifestJson = JSON.stringify(manifest), artifactSha256 = "pending";
  const release = { extension_id: manifest.id, version: "1.0.0", manifest, manifest_json: manifestJson, artifact_sha256: artifactSha256,
    publisher: { id: "pub_notes", key_id: "a".repeat(64), signature: "publisher-signature", payload_sha256: "b".repeat(64) } };
  const ownerRow = { instance_id: "owner-install", extension_id: manifest.id, project_id: null, user_id: null, scope: "SPACE_SHARED",
    instance_key: "default", status: "active", release_version: "1.0.0", pinned_artifact_sha256: artifactSha256, manifest };
  const rows: Array<Record<string, unknown>> = [ownerRow];
  let ownerActive = true, publisherActive = true;
  const spaceRequests: Request[] = [], microAppRequests: Request[] = [];
  const spaceStub = { fetch: vi.fn(async (request: Request) => {
    spaceRequests.push(request);
    const url = new URL(request.url), path = url.pathname;
    if (path === "/space-shared-extension-runtime") return Response.json({ managed: true, active: ownerActive, releaseValid: ownerActive,
      dependenciesResolved: ownerActive, installationId: "owner-install", extensionId: manifest.id, releaseVersion: "1.0.0",
      publisherId: "pub_notes", publisherKeyId: "a".repeat(64) });
    if (path === "/extension-installations") return Response.json({ installations: rows });
    if (path === "/extension-package-release") return Response.json({ release });
    if (path === "/extensions" && request.method === "POST") {
      const body = await request.clone().json() as { userId: string; instanceKey: string };
      rows.push({ instance_id: "user-install-a", extension_id: manifest.id, project_id: null, user_id: body.userId,
        scope: "SPACE_USER", instance_key: body.instanceKey, status: "staging", release_version: "1.0.0",
        pinned_artifact_sha256: release.artifact_sha256, manifest });
      return Response.json({ installationId: "user-install-a", release: { version: "1.0.0", artifactSha256: release.artifact_sha256,
        hostSignature: await signHmac(JSON.stringify([manifest.id, "1.0.0", manifestJson, release.artifact_sha256]), secret) } }, { status: 201 });
    }
    if (path === "/extension-installation/activate") {
      const body = await request.clone().json() as { installationId: string };
      Object.assign(rows.find(row => row.instance_id === body.installationId)!, { status: "active" });
      return Response.json({ activated: true, status: "active" });
    }
    if (path === "/extension-installation/abort") {
      const body = await request.clone().json() as { installationId: string };
      Object.assign(rows.find(row => row.instance_id === body.installationId)!, { status: "removed" });
      return Response.json({ aborted: true });
    }
    if (path === "/extension-runtime-work") return Response.json({ acquired: true, released: true });
    return Response.json({ error_code: "unexpected_space_route", path }, { status: 404 });
  }) };
  const actorFetch = vi.fn(async (request: Request) => {
    microAppRequests.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/initialize") return Response.json({ initialized: true }, { status: 201 });
    if (url.pathname === "/app") return new Response(html, { headers: { "content-type": "text/html" } });
    return Response.json({ path: url.pathname + url.search, user: request.headers.get("x-naelao-user-id") });
  });
  const app = new Hono();
  app.onError(error => errorResponse(error, "product_user_micro_app_test"));
  registerProductUserMicroAppRoutes(app as never);
  const platformDb = { prepare: (query: string) => ({ bind: (...params: unknown[]) => ({ first: async () => {
    if (query.includes("FROM spaces s JOIN orgs")) return { active: 1 };
    if (query.includes("space_members")) return params[3] === "user-a" ? { role: "member" } : null;
    if (query.includes("extension_publisher_keys")) return publisherActive ? { active: 1 } : null;
    return null;
  } }) }) };
  const env = {
    PLATFORM_SECRET: secret, PLATFORM_DB: platformDb,
    SPACE_DO: { idFromName: () => "space-do-id", get: () => spaceStub },
    MICRO_APP_DO: { idFromName: (name: string) => name, get: () => ({ fetch: actorFetch }) },
    SCRIPTS_R2: { get: async (key: string) => {
      const source = key.endsWith("/notes.html") ? html : key.endsWith("/handler.ts") ? handler : null;
      if (source === null) return null;
      const bytes = new TextEncoder().encode(source);
      return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
    } },
  } as never;
  return { app, env, rows, release, spaceRequests, microAppRequests, actorFetch,
    setOwnerActive(value: boolean) { ownerActive = value; }, setPublisherActive(value: boolean) { publisherActive = value; },
    async setArtifactDigest() {
      const value = await digest([["./handler.ts", handler], ["./notes.html", html]]);
      release.artifact_sha256 = value;
      ownerRow.pinned_artifact_sha256 = value;
      return value;
    } };
}

async function headers(role = "product_end_user", userId = "user-a") {
  return { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": userId, "x-naelao-role": role,
    "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
}

describe("product-user MicroApp lifecycle and caller", () => {
  it("lists owner-approved apps, activates only the caller actor, and serves its app and data API", async () => {
    const h = harness();
    await h.setArtifactDigest();
    const listed = await h.app.request("/spaces/space-a/product-users/me/micro-apps", { headers: await headers() }, h.env);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ apps: [{ installation_id: "owner-install", app_id: "personal_notes",
      gadget_scope: "SPACE_USER", status: "available" }] });

    const activatePath = "/spaces/space-a/product-users/me/micro-apps/owner-install/personal_notes/activate";
    const activated = await h.app.request(activatePath, { method: "POST", headers: await headers() }, h.env);
    expect(activated.status, JSON.stringify(await activated.clone().json())).toBe(201);
    expect(await activated.json()).toMatchObject({ user_installation_id: "user-install-a", status: "active" });
    expect(h.rows).toContainEqual(expect.objectContaining({ instance_id: "user-install-a", user_id: "user-a", scope: "SPACE_USER", status: "active" }));
    expect(h.actorFetch).toHaveBeenCalledWith(expect.objectContaining({ url: expect.anything() }));
    expect(await h.microAppRequests[0]!.clone().json()).toMatchObject({ appId: "personal_notes", scope: "SPACE_USER",
      gadgetTier: 1, userId: "user-a", extensionInstallationId: "user-install-a", sourceGadgetId: "personal_notes" });

    const replay = await h.app.request(activatePath, { method: "POST", headers: await headers() }, h.env);
    expect(replay.status).toBe(200);
    expect(h.spaceRequests.filter(request => new URL(request.url).pathname === "/extensions")).toHaveLength(1);
    expect(h.microAppRequests.filter(request => new URL(request.url).pathname === "/initialize")).toHaveLength(1);

    const page = await h.app.request("/spaces/space-a/product-users/me/micro-apps/owner-install/personal_notes/app", { headers: await headers() }, h.env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Personal notes");
    const data = await h.app.request("/spaces/space-a/product-users/me/micro-apps/owner-install/personal_notes/api/data?key=mine", { headers: await headers() }, h.env);
    expect(await data.json()).toEqual({ path: "/api/data?key=mine", user: "user-a" });
    expect(h.microAppRequests.at(-1)?.headers.get("x-naelao-active-installation-id")).toBe("user-install-a");
  });

  it("blocks cross-user access, a revoked publisher, and a removed owner installation", async () => {
    const h = harness();
    await h.setArtifactDigest();
    const activatePath = "/spaces/space-a/product-users/me/micro-apps/owner-install/personal_notes/activate";
    const active = await h.app.request(activatePath, { method: "POST", headers: await headers() }, h.env);
    expect(active.status).toBe(201);
    const priorCalls = h.actorFetch.mock.calls.length;

    const crossUser = await h.app.request("/spaces/space-a/product-users/me/micro-apps/owner-install/personal_notes/app", { headers: await headers("product_end_user", "user-b") }, h.env);
    expect(crossUser.status).toBe(403);
    expect(h.actorFetch).toHaveBeenCalledTimes(priorCalls);

    h.setPublisherActive(false);
    const revoked = await h.app.request("/spaces/space-a/product-users/me/micro-apps/owner-install/personal_notes/app", { headers: await headers() }, h.env);
    expect(revoked.status).toBe(503);
    expect(h.actorFetch).toHaveBeenCalledTimes(priorCalls);

    h.setPublisherActive(true);
    h.setOwnerActive(false);
    const removed = await h.app.request("/spaces/space-a/product-users/me/micro-apps/owner-install/personal_notes/app", { headers: await headers() }, h.env);
    expect(removed.status).toBe(503);
    expect(h.actorFetch).toHaveBeenCalledTimes(priorCalls);
  });

  it("does not admit builder/admin identities through the product-user caller", async () => {
    const h = harness();
    const response = await h.app.request("/spaces/space-a/product-users/me/micro-apps", { headers: await headers("admin") }, h.env);
    expect(response.status).toBe(404);
    expect(h.spaceRequests).toHaveLength(0);
  });
});
