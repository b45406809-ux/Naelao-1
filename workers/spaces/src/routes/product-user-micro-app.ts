import type { Context, Hono } from "hono";
import { digestExtensionManifest, validateExtensionManifest, type ExtensionManifest } from "@naelao/agent-sdk";
import { getDOName, signHmac } from "@naelao/crypto";
import { mintInternalToken, readBoundedRequestBytes, readBoundedResponseJson, requireInternalHmac } from "@naelao/http";
import type { Env } from "../index.js";
import { gadgetActorId } from "../do/MicroAppDO.js";
import { resolveEndUserSpaceRole } from "../space-auth.js";
import { extensionRuntimeWork, releaseRuntimeWorkAfterResponse, sharedExtensionRuntimeError } from "./gadget-mcp.js";

const MAX_USER_APP_BODY_BYTES = 1024 * 1024;
const USER_GADGET_SCOPES = new Set(["USER_PRIVATE", "SPACE_USER"]);
type InstallationRow = {
  instance_id: string; extension_id: string; project_id: string | null; user_id: string | null;
  scope: string; instance_key: string; status: string; release_version: string | null;
  pinned_artifact_sha256?: string | null; manifest?: ExtensionManifest;
};
type UserGadget = { id: string; name: string; scope: "USER_PRIVATE" | "SPACE_USER"; schema: string;
  migrations: Array<{ version: number; description: string; up: string }>; source: "bundle" | "legacy" };
type SignedPackage = { row: InstallationRow; manifest: ExtensionManifest; gadget: UserGadget; appId: string;
  runtime: Awaited<ReturnType<typeof sharedExtensionRuntimeError>> };

function userIdentity(c: Context<{ Bindings: Env }>) {
  return { tenantId: c.req.header("x-naelao-tenant-id") ?? "", userId: c.req.header("x-naelao-user-id") ?? "",
    role: c.req.header("x-naelao-role") ?? "" };
}

function validPackageIdentity(installationId: string, appId: string): boolean {
  return /^[A-Za-z0-9._:-]{1,768}$/.test(installationId) && /^[a-z][a-z0-9_-]{1,63}$/.test(appId);
}

async function authorizeProductUser(c: Context<{ Bindings: Env }>): Promise<{ tenantId: string; userId: string; spaceId: string } | Response> {
  const { tenantId, userId, role } = userIdentity(c), spaceId = c.req.param("spaceId") ?? "";
  if (role !== "product_end_user" || !tenantId || !userId || !spaceId)
    return c.json({ error_code: "product_user_required" }, 404);
  const space = await c.env.PLATFORM_DB.prepare(`SELECT 1 AS active FROM spaces s JOIN orgs o ON o.id=s.tenant_id
    WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'`).bind(spaceId, tenantId).first();
  if (!space) return c.notFound();
  if (!await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, userId, tenantId))
    return c.json({ error_code: "space_membership_required" }, 403);
  return { tenantId, userId, spaceId };
}

async function spaceStub(env: Env, tenantId: string, spaceId: string) {
  const name = await getDOName("space", spaceId, tenantId, env.PLATFORM_SECRET);
  return env.SPACE_DO.get(env.SPACE_DO.idFromName(name));
}

async function installations(stub: { fetch(request: Request): Promise<Response> }, tenantId: string, spaceId: string): Promise<InstallationRow[] | null> {
  try {
    const query = new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, extension_id: "__all__", include_manifest: "1" });
    const response = await stub.fetch(new Request(`http://space-do/extension-installations?${query}`));
    if (!response.ok) return null;
    const value = await readBoundedResponseJson<{ installations?: unknown }>(response, 2 * 1024 * 1024);
    return Array.isArray(value.installations) ? value.installations as InstallationRow[] : null;
  } catch { return null; }
}

function declaredUserGadgets(manifest: ExtensionManifest): UserGadget[] {
  const bundle = (manifest.bundle?.primitives ?? []).flatMap(primitive => primitive.kind === "gadget"
    && USER_GADGET_SCOPES.has(primitive.scope) && (primitive.businessActions?.length ?? 0) === 0
    && primitive.permissions.length === 0 && primitive.capabilityRequirements.length === 0
    ? [{ id: primitive.id, name: primitive.id, scope: primitive.scope as UserGadget["scope"], schema: primitive.schemaSql ?? "",
      migrations: [...(primitive.migrations ?? [])], source: "bundle" as const }] : []);
  const legacy = (manifest.gadgets ?? []).flatMap(gadget => USER_GADGET_SCOPES.has(gadget.scope) && gadget.gadgetTier === 1
    && (gadget.businessActions?.length ?? 0) === 0
    ? [{ id: gadget.id, name: gadget.name, scope: gadget.scope as UserGadget["scope"], schema: gadget.defaultSchemaSql,
      migrations: [...(gadget.migrations ?? [])], source: "legacy" as const }] : []);
  return [...bundle, ...legacy];
}

async function resolveSignedPackage(env: Env, tenantId: string, spaceId: string, installationId: string, appId: string,
  userId: string): Promise<SignedPackage | Response> {
  if (!validPackageIdentity(installationId, appId)) return Response.json({ error_code: "micro_app_identity_invalid" }, { status: 400 });
  const runtime = await sharedExtensionRuntimeError(env, tenantId, spaceId, appId);
  if (runtime.error) return Response.json({ error_code: runtime.error }, { status: 503 });
  if (!runtime.managed || runtime.installationId !== installationId || !runtime.extensionId || !runtime.releaseVersion)
    return Response.json({ error_code: "micro_app_owner_installation_inactive" }, { status: 409 });
  const stub = await spaceStub(env, tenantId, spaceId), rows = await installations(stub, tenantId, spaceId);
  if (!rows) return Response.json({ error_code: "micro_app_installation_lookup_unavailable" }, { status: 503 });
  const row = rows.find(item => item.instance_id === installationId && item.extension_id === runtime.extensionId
    && item.scope === "SPACE_SHARED" && item.project_id === null && item.status === "active"
    && item.release_version === runtime.releaseVersion && item.manifest && item.pinned_artifact_sha256);
  if (!row || !row.manifest || !row.pinned_artifact_sha256)
    return Response.json({ error_code: "micro_app_owner_installation_unavailable" }, { status: 409 });
  let manifest: ExtensionManifest;
  try { manifest = validateExtensionManifest(row.manifest); }
  catch { return Response.json({ error_code: "micro_app_manifest_invalid" }, { status: 409 }); }
  if (!manifest.bundle || manifest.id !== runtime.extensionId || manifest.bundle.version !== runtime.releaseVersion
    || await digestExtensionManifest(manifest).catch(() => "") !== await digestExtensionManifest(row.manifest).catch(() => ""))
    return Response.json({ error_code: "micro_app_manifest_pin_mismatch" }, { status: 409 });
  const prefix = row.instance_key && row.instance_key !== "default" ? `${row.instance_key}_` : "";
  const primitiveId = prefix && appId.startsWith(prefix) ? appId.slice(prefix.length) : prefix ? "" : appId;
  const gadget = declaredUserGadgets(manifest).find(candidate => candidate.id === primitiveId);
  if (!primitiveId || !gadget) return Response.json({ error_code: "micro_app_not_declared_for_product_users" }, { status: 404 });
  return { row, manifest, gadget, appId, runtime };
}

async function releaseForPackage(env: Env, tenantId: string, spaceId: string, value: SignedPackage) {
  const stub = await spaceStub(env, tenantId, spaceId);
  const query = new URLSearchParams({ extension_id: value.row.extension_id, version: value.row.release_version ?? "" });
  const response = await stub.fetch(new Request(`http://space-do/extension-package-release?${query}`));
  if (!response.ok) return null;
  const payload = await readBoundedResponseJson<{ release?: { extension_id: string; version: string; manifest: unknown;
    manifest_json: string; artifact_sha256: string; publisher?: { id?: string; key_id?: string; signature?: string; payload_sha256?: string } } }>(response, 2 * 1024 * 1024).catch(() => null);
  const release = payload?.release;
  if (!release || release.extension_id !== value.row.extension_id || release.version !== value.row.release_version
    || release.manifest_json !== JSON.stringify(value.manifest) || release.artifact_sha256 !== value.row.pinned_artifact_sha256
    || typeof release.publisher?.id !== "string" || typeof release.publisher.key_id !== "string"
    || typeof release.publisher.signature !== "string" || typeof release.publisher.payload_sha256 !== "string") return null;
  const activePublisher = await env.PLATFORM_DB.prepare(`SELECT 1 AS active FROM extension_publisher_keys
    WHERE tenant_id=? AND space_id=? AND publisher_id=? AND key_id=? AND status='active'`)
    .bind(tenantId, spaceId, release.publisher.id, release.publisher.key_id).first();
  if (!activePublisher) return null;
  return release;
}

async function readSignedArtifacts(env: Env, spaceId: string, value: SignedPackage, release: NonNullable<Awaited<ReturnType<typeof releaseForPackage>>>) {
  if (!env.SCRIPTS_R2) return null;
  const canvases = (value.manifest.bundle?.primitives ?? []).filter((primitive): primitive is Extract<typeof primitive, { kind: "canvas" }> => primitive.kind === "canvas");
  if (!canvases.length) return null;
  const channels = (value.manifest.bundle?.primitives ?? []).filter((primitive): primitive is Extract<typeof primitive, { kind: "channel" }> => primitive.kind === "channel");
  const legacyPaths = (value.manifest.gadgets ?? []).filter(gadget => USER_GADGET_SCOPES.has(gadget.scope) && gadget.gadgetTier === 1)
    .map(gadget => gadget.viewportComponent);
  const declaredPaths = [...canvases.map(canvas => canvas.component), ...channels.map(channel => channel.handlerScript), ...legacyPaths];
  if (declaredPaths.some(path => !/^\.\/[A-Za-z0-9._-]{1,128}\.(?:html|ts|js)$/.test(path))
    || new Set(declaredPaths).size !== declaredPaths.length) return null;
  const paths = [...declaredPaths].sort(), artifacts: Array<[string, string]> = [];
  let totalBytes = 0;
  for (const path of paths) {
    const object = await env.SCRIPTS_R2.get(`spaces/${spaceId}/extensions/${value.row.extension_id}/${value.row.release_version}/${path.slice(2)}`);
    const maxBytes = /\.(?:ts|js)$/.test(path) ? 262_144 : 512_000;
    if (!object || object.size < 1 || object.size > maxBytes) return null;
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== object.size) return null;
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return null; }
    totalBytes += bytes.byteLength;
    if (totalBytes > 2_000_000) return null;
    artifacts.push([path, source]);
  }
  const artifactSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(artifacts))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (artifactSha256 !== release.artifact_sha256) return null;
  return { artifacts, canvas: canvases[0]!, html: artifacts.find(([path]) => path === canvases[0]!.component)?.[1] };
}

async function activateUserGadget(env: Env, tenantId: string, spaceId: string, userId: string, value: SignedPackage): Promise<Response> {
  const stub = await spaceStub(env, tenantId, spaceId);
  const rows = await installations(stub, tenantId, spaceId);
  if (!rows) return Response.json({ error_code: "micro_app_installation_lookup_unavailable" }, { status: 503 });
  const existing = rows.find(row => row.extension_id === value.row.extension_id && row.scope === "SPACE_USER"
    && row.user_id === userId && row.instance_key === value.row.instance_key);
  if (existing?.status === "active") {
    if (existing.release_version !== value.row.release_version || existing.pinned_artifact_sha256 !== value.row.pinned_artifact_sha256)
      return Response.json({ error_code: "micro_app_user_installation_release_stale" }, { status: 409 });
    return Response.json({ installation_id: value.row.instance_id, user_installation_id: existing.instance_id,
      app_id: value.appId, gadget_scope: value.gadget.scope, status: "active", already_active: true },
      { headers: { "cache-control": "private, no-store" } });
  }
  if (existing && existing.status !== "staging")
    return Response.json({ error_code: "micro_app_user_installation_inactive" }, { status: 409 });

  const release = await releaseForPackage(env, tenantId, spaceId, value);
  if (!release) return Response.json({ error_code: "micro_app_release_untrusted_or_revoked" }, { status: 409 });
  const artifact = await readSignedArtifacts(env, spaceId, value, release);
  if (!artifact || typeof artifact.html !== "string") return Response.json({ error_code: "micro_app_artifact_unavailable_or_changed" }, { status: 409 });
  const prefix = value.row.instance_key && value.row.instance_key !== "default" ? `${value.row.instance_key}_` : "";
  const canvasSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(artifact.html)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const hostSignature = await signHmac(JSON.stringify([value.row.extension_id, value.row.release_version, release.manifest_json, release.artifact_sha256]), env.PLATFORM_SECRET);
  const bindingPayload = JSON.stringify([value.row.extension_id, value.row.release_version, release.manifest_json,
    release.artifact_sha256, hostSignature, artifact.canvas.component, canvasSha256]);
  const releaseProof = { extensionId: value.row.extension_id, version: value.row.release_version!, manifestJson: release.manifest_json,
    artifactSha256: release.artifact_sha256, hostSignature, canvasPath: artifact.canvas.component, canvasSha256,
    bindingSignature: await signHmac(bindingPayload, env.PLATFORM_SECRET) };
  const initResponse = await stub.fetch(new Request("http://space-do/extensions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: value.manifest, installedBy: userId, gatekeeperCapabilities: value.manifest.capabilityRequirements,
      tenantId, spaceId, scope: "SPACE_USER", userId, instanceKey: value.row.instance_key,
      artifactSha256: release.artifact_sha256, publisherId: release.publisher!.id, publisherKeyId: release.publisher!.key_id,
      publisherSignature: release.publisher!.signature, publisherPayloadSha256: release.publisher!.payload_sha256, deferActivation: true }) }));
  if (!initResponse.ok) return Response.json({ error_code: "micro_app_user_installation_rejected" }, { status: 409 });
  const installed = await readBoundedResponseJson<{ installationId?: string; release?: { version?: string; artifactSha256?: string; hostSignature?: string } }>(initResponse, 64 * 1024).catch(() => null);
  if (!installed?.installationId || installed.release?.version !== value.row.release_version
    || installed.release.artifactSha256 !== release.artifact_sha256 || installed.release.hostSignature !== hostSignature)
    return Response.json({ error_code: "micro_app_user_installation_attestation_invalid" }, { status: 503 });

  const actorId = gadgetActorId(env.MICRO_APP_DO, { scope: value.gadget.scope, spaceId, appId: value.appId, userId });
  const initialized = await env.MICRO_APP_DO.get(actorId).fetch(new Request("http://micro-app/initialize", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: value.appId, scope: value.gadget.scope,
      gadgetTier: 1, userId, defaultSchemaSql: value.gadget.schema, migrations: value.gadget.migrations,
      extensionInstallationId: installed.installationId, sourceGadgetId: value.gadget.id, html: artifact.html, releaseProof }) }));
  const abort = async () => stub.fetch(new Request("http://space-do/extension-installation/abort", { method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ installationId: installed.installationId, tenantId, spaceId, scope: "SPACE_USER", userId }) })).catch(() => undefined);
  if (!initialized.ok) { await abort(); return Response.json({ error_code: "micro_app_user_actor_initialization_failed" }, { status: 503 }); }
  if (!await resolveEndUserSpaceRole(env.PLATFORM_DB, spaceId, userId, tenantId)) {
    await abort();
    return Response.json({ error_code: "space_membership_required" }, { status: 403 });
  }
  const current = await sharedExtensionRuntimeError(env, tenantId, spaceId, value.appId);
  if (current.error || !current.managed || current.installationId !== value.row.instance_id || current.releaseVersion !== value.row.release_version) {
    await abort();
    return Response.json({ error_code: "micro_app_owner_installation_changed" }, { status: 409 });
  }
  const activated = await stub.fetch(new Request("http://space-do/extension-installation/activate", { method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ installationId: installed.installationId, extensionId: value.row.extension_id,
      version: value.row.release_version, artifactSha256: release.artifact_sha256, tenantId, spaceId,
      scope: "SPACE_USER", userId }) }));
  if (!activated.ok) { await abort(); return Response.json({ error_code: "micro_app_user_installation_activation_failed" }, { status: 503 }); }
  return Response.json({ installation_id: value.row.instance_id, user_installation_id: installed.installationId,
    app_id: value.appId, gadget_scope: value.gadget.scope, status: "active", already_active: false },
    { status: 201, headers: { "cache-control": "private, no-store" } });
}

async function activeUserActor(env: Env, tenantId: string, spaceId: string, userId: string, value: SignedPackage) {
  if (!await resolveEndUserSpaceRole(env.PLATFORM_DB, spaceId, userId, tenantId))
    return { error: Response.json({ error_code: "space_membership_required" }, { status: 403 }) };
  const rows = await installations(await spaceStub(env, tenantId, spaceId), tenantId, spaceId);
  if (!rows) return { error: Response.json({ error_code: "micro_app_installation_lookup_unavailable" }, { status: 503 }) };
  const userInstall = rows.find(row => row.extension_id === value.row.extension_id && row.scope === "SPACE_USER"
    && row.user_id === userId && row.instance_key === value.row.instance_key && row.status === "active");
  if (!userInstall || userInstall.release_version !== value.row.release_version
    || userInstall.pinned_artifact_sha256 !== value.row.pinned_artifact_sha256)
    return { error: Response.json({ error_code: "micro_app_user_activation_required" }, { status: 409 }) };
  const actor = gadgetActorId(env.MICRO_APP_DO, { scope: value.gadget.scope, spaceId, appId: value.appId, userId });
  const workId = crypto.randomUUID();
  const lease = await extensionRuntimeWork(env, { action: "acquire", tenantId, spaceId, projectId: null,
    installationId: value.row.instance_id, workId, workKind: "gadget" });
  if (lease.acquired !== true) return { error: Response.json({ error_code: lease.errorCode ?? "extension_installation_inactive" }, { status: 409 }) };
  return { actor, userInstallationId: userInstall.instance_id, releaseVersion: userInstall.release_version!,
    release: () => extensionRuntimeWork(env, { action: "release", tenantId, spaceId, projectId: null,
      installationId: value.row.instance_id, workId, workKind: "gadget" }) };
}

async function forwardUserApp(c: Context<{ Bindings: Env }>, path: "/app" | "/api/data" | "/api/storage" | "/mcp",
  method: "GET" | "POST" | "DELETE") {
  const identity = await authorizeProductUser(c);
  if (identity instanceof Response) return identity;
  const { installationId = "", appId = "" } = c.req.param();
  const value = await resolveSignedPackage(c.env, identity.tenantId, identity.spaceId, installationId, appId, identity.userId);
  if (value instanceof Response) return value;
  const actor = await activeUserActor(c.env, identity.tenantId, identity.spaceId, identity.userId, value);
  if ("error" in actor) return actor.error;
  let body: Uint8Array | undefined;
  if (method === "POST") {
    try { body = await readBoundedRequestBytes(c.req.raw, MAX_USER_APP_BODY_BYTES); }
    catch { await actor.release(); return c.json({ error_code: "payload_too_large" }, 413); }
  }
  const forwardedHeaders = new Headers({ "x-naelao-user-id": identity.userId, "x-naelao-role": "member" });
  if (method === "POST") forwardedHeaders.set("content-type", c.req.header("content-type") ?? "application/json");
  forwardedHeaders.set("x-naelao-active-installation-id", actor.userInstallationId);
  forwardedHeaders.set("x-naelao-active-release-version", actor.releaseVersion);
  const target = path === "/api/data" && method !== "POST" ? `${path}${new URL(c.req.url).search}` : path;
  try {
    const response = await c.env.MICRO_APP_DO.get(actor.actor).fetch(new Request(`http://micro-app${target}`, {
      method, headers: forwardedHeaders, ...(body ? { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer } : {}),
    }));
    return await releaseRuntimeWorkAfterResponse(new Response(response.body, { status: response.status, headers: response.headers }), actor.release);
  } catch (error) { await actor.release(); throw error; }
}

export function registerProductUserMicroAppRoutes(app: Hono<{ Bindings: Env }>): void {
  app.use("/spaces/:spaceId/product-users/me/micro-apps", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
  app.use("/spaces/:spaceId/product-users/me/micro-apps/*", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));

  app.get("/spaces/:spaceId/product-users/me/micro-apps", async c => {
    const identity = await authorizeProductUser(c);
    if (identity instanceof Response) return identity;
    const stub = await spaceStub(c.env, identity.tenantId, identity.spaceId);
    const rows = await installations(stub, identity.tenantId, identity.spaceId);
    if (!rows) return c.json({ error_code: "micro_app_installation_lookup_unavailable" }, 503);
    const apps: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      if (row.scope !== "SPACE_SHARED" || row.status !== "active" || !row.manifest || !row.release_version) continue;
      let manifest: ExtensionManifest;
      try { manifest = validateExtensionManifest(row.manifest); } catch { continue; }
      const prefix = row.instance_key && row.instance_key !== "default" ? `${row.instance_key}_` : "";
      for (const gadget of declaredUserGadgets(manifest)) {
        const appId = `${prefix}${gadget.id}`;
        const runtime = await sharedExtensionRuntimeError(c.env, identity.tenantId, identity.spaceId, appId);
        if (runtime.error || !runtime.managed || runtime.installationId !== row.instance_id
          || runtime.releaseVersion !== row.release_version) continue;
        const installed = rows.find(candidate => candidate.extension_id === row.extension_id && candidate.scope === "SPACE_USER"
          && candidate.user_id === identity.userId && candidate.instance_key === row.instance_key && candidate.status === "active"
          && candidate.release_version === row.release_version);
        apps.push({ installation_id: row.instance_id, extension_id: row.extension_id, release_version: row.release_version,
          app_id: appId, gadget_scope: gadget.scope, name: gadget.name, status: installed ? "active" : "available",
          activation_url: `/spaces/${encodeURIComponent(identity.spaceId)}/product-users/me/micro-apps/${encodeURIComponent(row.instance_id)}/${encodeURIComponent(appId)}/activate`,
          app_url: `/spaces/${encodeURIComponent(identity.spaceId)}/product-users/me/micro-apps/${encodeURIComponent(row.instance_id)}/${encodeURIComponent(appId)}/app` });
      }
    }
    return c.json({ apps }, { headers: { "cache-control": "private, no-store" } });
  });

  app.post("/spaces/:spaceId/product-users/me/micro-apps/:installationId/:appId/activate", async c => {
    const identity = await authorizeProductUser(c);
    if (identity instanceof Response) return identity;
    const value = await resolveSignedPackage(c.env, identity.tenantId, identity.spaceId,
      c.req.param("installationId") ?? "", c.req.param("appId") ?? "", identity.userId);
    if (value instanceof Response) return value;
    return activateUserGadget(c.env, identity.tenantId, identity.spaceId, identity.userId, value);
  });

  app.get("/spaces/:spaceId/product-users/me/micro-apps/:installationId/:appId/app", c => forwardUserApp(c, "/app", "GET"));
  app.get("/spaces/:spaceId/product-users/me/micro-apps/:installationId/:appId/api/data", c => forwardUserApp(c, "/api/data", "GET"));
  app.post("/spaces/:spaceId/product-users/me/micro-apps/:installationId/:appId/api/data", c => forwardUserApp(c, "/api/data", "POST"));
  app.delete("/spaces/:spaceId/product-users/me/micro-apps/:installationId/:appId/api/data", c => forwardUserApp(c, "/api/data", "DELETE"));
  app.get("/spaces/:spaceId/product-users/me/micro-apps/:installationId/:appId/api/storage", c => forwardUserApp(c, "/api/storage", "GET"));
  app.post("/spaces/:spaceId/product-users/me/micro-apps/:installationId/:appId/mcp", c => forwardUserApp(c, "/mcp", "POST"));
}
