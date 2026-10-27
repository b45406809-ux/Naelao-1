import { describe, expect, it } from "vitest";
import { SpaceDO } from "./SpaceDO.js";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { mintInternalToken } from "@naelao/http";
import { PERSONAL_ASSISTANT_SPACE_TEMPLATE } from "@naelao/agent-sdk";

const planDb = { prepare: () => ({ bind: () => ({ first: async () => ({ plan_tier: "free" }) }) }) };

const image = "registry.example/media@sha256:" + "a".repeat(64);
function manifest(binary = "ffmpeg") {
  return { id: "ext_runtime_ffmpeg", type: "extension", declaredPermissions: ["container:execute"], capabilityRequirements: ["native-execution"],
    gadgets: [], daemons: [], commands: [], containers: [{ schemaVersion: "1.0", kind: "container", id: "ffmpeg", version: "1.0.0",
      permissions: [{ scope: "PROJECT_BOUND", actions: ["execute"], resource: "workspace" }], capabilityRequirements: ["native-execution"], lifecycle: {},
      image, resources: { memoryMb: 4096, cpuCores: 0.5, timeoutSeconds: 60 }, exportedBinaries: [binary], networkPolicy: "none" }] };
}

describe("runtime extension installation", () => {
  it("requires owner-approved per-installation grants and exposes only approved access to workers", async () => {
    const storage = createDOStorage(), secret = "filesystem-grant-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: secret } as never);
    const manifest = { id: "ext_shared_drive_demo", type: "extension", declaredPermissions: [], capabilityRequirements: ["space.shared.read", "space.shared.write"],
      gadgets: [{ id: "shared_console", name: "Shared Console", viewportComponent: "./console.ts", scope: "SPACE_SHARED", gadgetTier: 3, defaultSchemaSql: "" }],
      daemons: [], commands: [], shared_filesystem: [{ path: "/space/shared/dropzones/audio/", access: "READ_WRITE" }] };
    const install = (approvedSharedFilesystem: Array<{ path: string; access: "READ" | "READ_WRITE" }> = []) => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED", gatekeeperCapabilities: manifest.capabilityRequirements, approvedSharedFilesystem }) }));
    const first = await install(); expect(first.status).toBe(201);
    const { installationId } = await first.json() as { installationId: string };
    const appList = await space.fetch(new Request("http://space/space-shared-extensions?tenant_id=tenant&space_id=space"));
    expect(await appList.json()).toMatchObject({ apps: [expect.objectContaining({ capabilities: [], requested_shared_filesystem: manifest.shared_filesystem, approved_shared_filesystem: [] })] });
    const lookup = () => space.fetch(new Request("http://space/workflow-installation?" + new URLSearchParams({ instance_id: installationId, tenant_id: "tenant", space_id: "space" })));
    expect(await (await lookup()).json()).toMatchObject({ approved_shared_filesystem: [] });
    const token = await mintInternalToken(secret, "tenant");
    const update = (grants: Array<{ path: string; access: "READ" | "READ_WRITE" }>) => space.fetch(new Request("http://space/extension-shared-filesystem-grants", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": token },
      body: JSON.stringify({ tenantId: "tenant", spaceId: "space", instanceId: installationId, approvedBy: "owner", grants }),
    }));
    expect((await update([{ path: "/space/shared/unrequested/", access: "READ" }])).status).toBe(400);
    expect((await update([{ path: "/space/shared/dropzones/audio/", access: "READ" }])).status).toBe(200);
    expect(await (await lookup()).json()).toMatchObject({ approved_shared_filesystem: [{ path: "/space/shared/dropzones/audio/", access: "READ" }] });
    const containerList = await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=owner&project_id="));
    expect(await containerList.json()).toMatchObject({ installations: [expect.objectContaining({ approved_shared_filesystem: [{ path: "/space/shared/dropzones/audio/", access: "READ" }] })] });
    await update([]);
    expect(await (await lookup()).json()).toMatchObject({ approved_shared_filesystem: [] });
  });

  it("host-signs immutable bundle releases and only rolls back to a verified recorded version", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: "release-test-secret" } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','A','active')");
    const bundleManifest = (version: string) => ({ id: "ext_versioned", type: "extension", declaredPermissions: [], capabilityRequirements: ["channel.invoke"], gadgets: [], daemons: [], commands: [],
      bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_versioned", version, primitives: [{ schemaVersion: "1.0", kind: "channel", id: "handler", version, permissions: [], capabilityRequirements: [], lifecycle: {}, provider: "whatsapp", handlerScript: "./handler.ts", context: "channel_only", inboundEvents: ["message.received"], outboundEvents: ["message.reply"] }] } });
    const call = (version: string, upgrade = false) => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: bundleManifest(version), installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND", gatekeeperCapabilities: ["channel.invoke"], artifactSha256: "a".repeat(64), upgrade }) }));
    const first = await call("1.0.0");
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ release: { version: "1.0.0", artifactSha256: "a".repeat(64), signer: "naelao-host", hostSignature: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect((await call("2.0.0")).status).toBe(409);
    expect((await call("2.0.0", true)).status).toBe(201);
    const releases = await space.fetch(new Request("http://space/extension-releases?extension_id=ext_versioned"));
    expect(await releases.json()).toMatchObject({ releases: expect.arrayContaining([
      expect.objectContaining({ version: "2.0.0", signatureValid: true }), expect.objectContaining({ version: "1.0.0", signatureValid: true }),
    ]) });
    const rollback = await space.fetch(new Request("http://space/extension-releases/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ extensionId: "ext_versioned", version: "1.0.0" }) }));
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({ rolledBack: true, manifest: { bundle: { version: "1.0.0" } } });
  });

  it("binds publisher identity to immutable releases and blocks a revoked publisher release", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: "publisher-test-secret" } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','A','active')");
    const manifest = { id: "ext_publisher_lifecycle", type: "extension", declaredPermissions: [], capabilityRequirements: ["channel.invoke"], gadgets: [], daemons: [], commands: [],
      bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_publisher_lifecycle", version: "1.0.0", primitives: [
        { schemaVersion: "1.0", kind: "channel", id: "handler", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {}, provider: "telegram", handlerScript: "./handler.ts", context: "channel_only", inboundEvents: ["message.received"], outboundEvents: ["message.reply"] },
      ] } };
    const publisher = { publisherId: "pub_example", publisherKeyId: "a".repeat(64), publisherSignature: "signature", publisherPayloadSha256: "b".repeat(64) };
    const install = (overrides = {}) => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest, installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND",
        gatekeeperCapabilities: ["channel.invoke"], artifactSha256: "c".repeat(64), ...publisher, ...overrides }) }));
    expect((await install()).status).toBe(201);
    const changedRelease = await install({ publisherSignature: "different-signature" });
    expect(changedRelease.status, await changedRelease.text()).toBe(409);
    const instances = storage.sql.exec("SELECT instance_id FROM extension_instances WHERE extension_id='ext_publisher_lifecycle'").toArray();
    expect(instances).toHaveLength(1);
    const instanceId = String(instances[0]?.instance_id);
    const lookup = () => space.fetch(new Request("http://space/workflow-installation?" + new URLSearchParams({ instance_id: instanceId, tenant_id: "tenant", space_id: "space" })));
    expect(await (await lookup()).json()).toMatchObject({ release: { signatureValid: true, publisher: { id: "pub_example", keyId: "a".repeat(64), revoked: false } } });
    const revoke = await space.fetch(new Request("http://space/extension-publisher-revoke?key_id=" + "a".repeat(64), { method: "POST" }));
    expect(revoke.status).toBe(200);
    expect(await (await lookup()).json()).toMatchObject({ release: { signatureValid: false, publisher: { revoked: true } } });
    const rollback = await space.fetch(new Request("http://space/extension-releases/rollback", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ extensionId: "ext_publisher_lifecycle", version: "1.0.0" }) }));
    expect(rollback.status).toBe(409);
  });

  it("installs a project-bound code indexer only for the selected project and preserves scope through restart", async () => {
    const storage = createDOStorage(), state = { storage };
    let space = new SpaceDO(state as never, { PLATFORM_DB: planDb } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','A','active'),('project-b','space','B','active')");
    const lsp = { id: "ext_lsp_indexer", type: "extension", declaredPermissions: ["repo.read", "facet.sqlite.read", "facet.sqlite.write"],
      capabilityRequirements: ["repo.read", "facet.sqlite.read", "facet.sqlite.write"], gadgets: [], daemons: [],
      commands: [{ name: "lsp", scriptPath: "./ext_lsp_indexer/command.ts" }] };
    const install = () => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: lsp, installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND", gatekeeperCapabilities: lsp.capabilityRequirements }) }));
    expect((await install()).status).toBe(201);
    const list = async (projectId: string) => space.fetch(new Request("http://space/container-installations?" + new URLSearchParams({
      tenant_id: "tenant", space_id: "space", user_id: "owner", project_id: projectId,
    })));
    const installed = await (await list("project-a")).json() as { installations: Array<{ instance: { scope: string; project_id: string | null } }> };
    expect(installed.installations).toEqual([expect.objectContaining({ instance: expect.objectContaining({ scope: "PROJECT_BOUND", project_id: "project-a" }) })]);
    expect((await install()).status).toBe(201);
    space = new SpaceDO(state as never, { PLATFORM_DB: planDb } as never);
    expect(await (await list("project-b")).json()).toMatchObject({ installations: [] });
  });

  it("stores a composed versioned bundle and exposes its validated channel primitive to the runtime", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: "test-platform-secret" } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','A','active')");
    const channel = { schemaVersion: "1.0", kind: "channel", id: "student_whatsapp", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {},
      provider: "whatsapp", connectionId: "student_channel", handlerScript: "./handler.ts", context: "channel_only", inboundEvents: ["message.received"], outboundEvents: ["message.reply"],
      knowledgeCollections: ["course_material"], session: { enabled: true, maxBytes: 2048, ttlDays: 30 } };
    const bundle = { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_trading_mentor", version: "1.0.0", primitives: [channel],
      connections: [{ id: "student_channel", provider: "whatsapp", purpose: "Receive student questions", required: true }],
      knowledge: [{ id: "course_material", purpose: "Answer questions from approved course materials", access: "owner_published_external" }] };
    const response = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: { id: "ext_trading_mentor", type: "extension", declaredPermissions: [], capabilityRequirements: ["channel.invoke"],
        gadgets: [], daemons: [], commands: [], bundle }, installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND", gatekeeperCapabilities: ["channel.invoke"] }) }));
    expect(response.status).toBe(201);
    const installation = await response.json() as { manifest: { bundle: { version: string } } };
    expect(installation.manifest.bundle.version).toBe("1.0.0");
    const listed = await space.fetch(new Request("http://space/channel-installations?tenant_id=tenant&space_id=space&project_id=project-a"));
    expect(await listed.json()).toMatchObject({ installations: [{ extension_id: "ext_trading_mentor",
      channels: [{ id: "student_whatsapp", provider: "whatsapp", handlerScript: "./handler.ts", connection_id: "student_channel" }],
      connections: [{ id: "student_channel", provider: "whatsapp", purpose: "Receive student questions", required: true }] }] });
  });

  it("removes only the active project installation addressed by tenant, space, and project", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, { PLATFORM_DB: planDb } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','A','active'),('project-b','space','B','active')");
    const installedResponse = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: manifest(), installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND", gatekeeperCapabilities: ["native-execution"] }) }));
    const installed = await installedResponse.json() as { installationId: string };
    const remove = (tenantId: string, projectId: string) => space.fetch(new Request("http://space/extension-installation?" + new URLSearchParams({
      instance_id: installed.installationId, tenant_id: tenantId, space_id: "space", project_id: projectId,
    }), { method: "DELETE" }));
    expect((await remove("tenant", "project-b")).status).toBe(404);
    expect(storage.sql.exec("SELECT status FROM extension_instances WHERE instance_id=?", installed.installationId).toArray()[0]?.status).toBe("active");
    expect(await (await remove("tenant", "project-a")).json()).toMatchObject({ removed: true, instance_id: installed.installationId });
    expect((await remove("tenant", "project-a")).status).toBe(404);
  });

  it("removes a Space-shared install at exact tenant and Space scope, revoking grants while retaining package data", async () => {
    const storage = createDOStorage(), space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project"));
    const response = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: manifest(), installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED", gatekeeperCapabilities: ["native-execution"] }) }));
    const { installationId } = await response.json() as { installationId: string };
    const all = await space.fetch(new Request("http://space/extension-installations?" + new URLSearchParams({ tenant_id: "tenant", space_id: "space", extension_id: "__all__" })));
    expect(await all.json()).toMatchObject({ installations: [expect.objectContaining({ extension_id: "ext_runtime_ffmpeg", scope: "SPACE_SHARED" })] });
    storage.sql.exec("INSERT INTO extension_shared_filesystem_grants(instance_id,path,access,approved_by,approved_at) VALUES(?,?,?,?,?)", installationId, "/space/shared/docs", "READ", "owner", "2026-01-01");
    const remove = (tenantId: string, spaceId: string) => space.fetch(new Request("http://space/extension-installation?" + new URLSearchParams({ instance_id: installationId, tenant_id: tenantId, space_id: spaceId }), { method: "DELETE" }));
    expect((await remove("other-tenant", "space")).status).toBe(404);
    expect((await remove("tenant", "other-space")).status).toBe(404);
    await expect((await remove("tenant", "space")).json()).resolves.toMatchObject({ removed: true });
    expect(storage.sql.exec("SELECT status FROM extension_instances WHERE instance_id=?", installationId).toArray()[0]?.status).toBe("removed");
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM extension_shared_filesystem_grants WHERE instance_id=?", installationId).toArray()[0]?.count).toBe(0);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM installed_extensions WHERE extension_id='ext_runtime_ffmpeg'").toArray()[0]?.count).toBe(1);
  });

  it("blocks removal of a Space-shared extension required by an installed Space Template", async () => {
    const storage = createDOStorage(), space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id="));
    const extensionId = "ext_template_required_probe";
    const shared = { id: extensionId, type: "extension", declaredPermissions: [], capabilityRequirements: ["space.shared.read"],
      gadgets: [{ id: "required_app", name: "Required app", viewportComponent: "./app.ts", scope: "SPACE_SHARED", gadgetTier: 3, defaultSchemaSql: "" }],
      daemons: [], commands: [] };
    const installedResponse = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: shared, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED", gatekeeperCapabilities: shared.capabilityRequirements }) }));
    expect(installedResponse.status, await installedResponse.clone().text()).toBe(201);
    const { installationId } = await installedResponse.json() as { installationId: string };
    const blueprint = { ...structuredClone(PERSONAL_ASSISTANT_SPACE_TEMPLATE), id: "tpl_dependency_probe", requiredExtensions: [extensionId] };
    const activation = await space.fetch(new Request("http://space/blueprints/instantiate", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ blueprint, target_space_id: "space", activation_key: blueprint.id }) }));
    expect(activation.status, await activation.clone().text()).toBe(201);
    expect(storage.sql.exec("SELECT required_extensions_json FROM space_blueprint_installations WHERE space_id='space' AND blueprint_id=?", blueprint.id).toArray()[0]?.required_extensions_json).toBe(JSON.stringify([extensionId]));
    const remove = () => space.fetch(new Request("http://space/extension-installation?" + new URLSearchParams({ instance_id: installationId, tenant_id: "tenant", space_id: "space" }), { method: "DELETE" }));
    const blocked = await remove();
    expect(blocked.status, await blocked.clone().text()).toBe(409);
    expect(await blocked.json()).toMatchObject({ error_code: "extension_required_by_space_template", blueprint_id: blueprint.id });
    expect(storage.sql.exec("SELECT status FROM extension_instances WHERE instance_id=?", installationId).toArray()[0]?.status).toBe("active");
  });

  it("pauses and resumes Space-shared extensions without discarding their data or grants", async () => {
    const storage = createDOStorage(), secret = "lifecycle-secret", space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: secret } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id="));
    const shared = { id: "ext_shared_lifecycle", type: "extension", declaredPermissions: [], capabilityRequirements: ["space.shared.read"], gadgets: [
      { id: "shared_app", name: "Shared app", viewportComponent: "./app.ts", scope: "SPACE_SHARED", gadgetTier: 3, defaultSchemaSql: "" },
    ], daemons: [], commands: [], shared_filesystem: [{ path: "/space/shared/docs/", access: "READ" }] };
    const installed = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: shared, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED", gatekeeperCapabilities: shared.capabilityRequirements }) }));
    const { installationId } = await installed.json() as { installationId: string };
    storage.sql.exec("INSERT INTO extension_shared_filesystem_grants(instance_id,path,access,approved_by,approved_at) VALUES(?,?,?,?,?)", installationId, "/space/shared/docs/", "READ", "owner", "2026-01-01");
    const token = await mintInternalToken(secret, "tenant");
    const update = (action: "disable" | "enable", spaceId = "space") => space.fetch(new Request("http://space/space-shared-extension-lifecycle", { method: "PATCH", headers: { "content-type": "application/json", "x-naelao-internal-token": token },
      body: JSON.stringify({ tenantId: "tenant", spaceId, instanceId: installationId, action }) }));
    expect((await update("disable", "other-space")).status).toBe(404);
    expect(await (await update("disable")).json()).toMatchObject({ status: "disabled" });
    expect(await (await space.fetch(new Request("http://space/space-shared-extensions?tenant_id=tenant&space_id=space"))).json()).toMatchObject({ apps: [expect.objectContaining({ status: "disabled" })] });
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM extension_shared_filesystem_grants WHERE instance_id=?", installationId).toArray()[0]?.count).toBe(1);
    expect(await (await update("enable")).json()).toMatchObject({ status: "active" });
    expect(await (await space.fetch(new Request("http://space/space-shared-extensions?tenant_id=tenant&space_id=space"))).json()).toMatchObject({ apps: [expect.objectContaining({ status: "active" })] });
    await update("disable");
    const removal = await space.fetch(new Request(`http://space/extension-installation?${new URLSearchParams({ instance_id: installationId, tenant_id: "tenant", space_id: "space" })}`, { method: "DELETE" }));
    expect(removal.status).toBe(200);
    expect(storage.sql.exec("SELECT status FROM extension_instances WHERE instance_id=?", installationId).toArray()[0]?.status).toBe("removed");
  });

  it("pauses project extensions at the project boundary and exposes them only in the admin lifecycle view", async () => {
    const storage = createDOStorage(), secret = "project-lifecycle-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: secret } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','A','active'),('project-b','space','B','active')");
    const installed = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: manifest(), installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND", gatekeeperCapabilities: ["native-execution"] }) }));
    const { installationId } = await installed.json() as { installationId: string };
    const shared = { id: "ext_space_shared_lifecycle_view", type: "extension", declaredPermissions: [], capabilityRequirements: [], gadgets: [], daemons: [], commands: [] };
    await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: shared, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED", gatekeeperCapabilities: [] }) }));
    const token = await mintInternalToken(secret, "tenant");
    const lifecycle = (projectId: string, action: "disable" | "enable") => space.fetch(new Request("http://space/project-extension-lifecycle", { method: "PATCH", headers: { "content-type": "application/json", "x-naelao-internal-token": token },
      body: JSON.stringify({ tenantId: "tenant", spaceId: "space", projectId, instanceId: installationId, action }) }));
    expect((await lifecycle("project-b", "disable")).status).toBe(404);
    expect(await (await lifecycle("project-a", "disable")).json()).toMatchObject({ status: "disabled" });
    const runtimeList = await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    expect(await runtimeList.json()).toMatchObject({ installations: [] });
    const runtimeLookup = await space.fetch(new Request(`http://space/workflow-installation?instance_id=${installationId}&tenant_id=tenant&space_id=space`));
    expect(runtimeLookup.status).toBe(404);
    const cleanupLookup = await space.fetch(new Request(`http://space/workflow-installation?instance_id=${installationId}&tenant_id=tenant&space_id=space&include_disabled=1`));
    expect(await cleanupLookup.json()).toMatchObject({ instance: { status: "disabled", project_id: "project-a" } });
    const adminList = await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=owner&project_id=project-a&include_disabled=1"));
    const listed = await adminList.json() as { installations: Array<{ instance: { instance_id: string; status: string } }> };
    expect(listed.installations).toHaveLength(1);
    expect(listed.installations[0]).toMatchObject({ instance: { instance_id: installationId, status: "disabled" } });
    expect(await (await lifecycle("project-a", "enable")).json()).toMatchObject({ status: "active" });
  });

  it("validates scope before mutation, keeps manifests immutable, and replays installs after restart", async () => {
    const storage = createDOStorage();
    const state = { storage };
    let space = new SpaceDO(state as never, { PLATFORM_DB: planDb } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project','space','Project','active')");
    const call = (body: unknown) => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

    expect((await call({ manifest: manifest(), installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED", projectId: "spoof" })).status).toBe(400);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM installed_extensions").toArray()[0]?.count).toBe(0);

    const body = { manifest: manifest(), installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED", gatekeeperCapabilities: ["native-execution"] };
    const first = await call(body);
    expect(first.status).toBe(201);
    const installed = await first.json() as { installationId: string };
    expect(installed.installationId).toBeTruthy();
    expect((await call(body)).status).toBe(201);

    expect((await call({ ...body, manifest: manifest("ffprobe") })).status).toBe(409);
    expect(storage.sql.exec("SELECT manifest_json FROM installed_extensions WHERE extension_id='ext_runtime_ffmpeg'").toArray()[0]?.manifest_json).toContain("ffmpeg");
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM extension_instances").toArray()[0]?.count).toBe(1);

    space = new SpaceDO(state as never, { PLATFORM_DB: planDb } as never);
    const list = await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project"));
    expect(await list.json()).toMatchObject({ installations: [{ instance: { instance_id: installed.installationId, scope: "SPACE_SHARED" } }] });
  });

  it("creates distinct named instances of the same project extension without sharing IDs", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, { PLATFORM_DB: planDb } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project','space','Project','active')");
    const install = (instanceKey: string) => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: manifest(), installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project", scope: "PROJECT_BOUND", instanceKey, gatekeeperCapabilities: ["native-execution"] }) }));
    const live = await install("trading_live");
    const paper = await install("trading_paper");
    expect(live.status).toBe(201); expect(paper.status).toBe(201);
    const liveId = (await live.json() as { installationId: string }).installationId;
    const paperId = (await paper.json() as { installationId: string }).installationId;
    expect(paperId).not.toBe(liveId);
    expect(storage.sql.exec("SELECT instance_key FROM extension_instances WHERE instance_id IN (?,?) ORDER BY instance_key", liveId, paperId).toArray()).toEqual([
      { instance_key: "trading_live" }, { instance_key: "trading_paper" },
    ]);
    expect((await install("../shared")).status).toBe(400);
  });

  it("attests active Canvas runtimes by project install and revokes their route on uninstall", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: "canvas-runtime-secret" } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','A','active')");
    const canvasManifest = (version: string, canvasId: string) => ({ id: "ext_canvas_runtime", type: "extension", declaredPermissions: [], capabilityRequirements: ["extension.project_canvas"], gadgets: [], daemons: [], commands: [],
      bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_canvas_runtime", version, primitives: [
        { schemaVersion: "1.0", kind: "canvas", id: canvasId, version, permissions: [], capabilityRequirements: [], lifecycle: {}, layout: "CanvasMount", component: "./index.html", dynamicPage: false },
      ] } });
    const installedResponse = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: canvasManifest("1.0.0", "mentor_canvas"), installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND", gatekeeperCapabilities: ["extension.project_canvas"], artifactSha256: "a".repeat(64) }) }));
    expect(installedResponse.status).toBe(201);
    const installed = await installedResponse.json() as { installationId: string };
    const check = (appId: string) => space.fetch(new Request("http://space/project-extension-runtime?" + new URLSearchParams({ tenant_id: "tenant", space_id: "space", project_id: "project-a", app_id: appId })));
    const upgrade = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: canvasManifest("2.0.0", "renamed_canvas"), installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND", gatekeeperCapabilities: ["extension.project_canvas"], artifactSha256: "b".repeat(64), upgrade: true }) }));
    expect(upgrade.status).toBe(201);
    expect(await (await check("mentor_canvas")).json()).toEqual({ managed: true, active: false, releaseValid: false });
    expect(await (await check("renamed_canvas")).json()).toEqual({ managed: true, active: true, releaseValid: true });
    const removed = await space.fetch(new Request("http://space/extension-installation?" + new URLSearchParams({ instance_id: installed.installationId, tenant_id: "tenant", space_id: "space", project_id: "project-a" }), { method: "DELETE" }));
    expect(removed.status).toBe(200);
    expect(await (await check("mentor_canvas")).json()).toEqual({ managed: true, active: false, releaseValid: false });
    expect(await (await check("renamed_canvas")).json()).toEqual({ managed: true, active: false, releaseValid: false });
    expect(await (await space.fetch(new Request("http://space/project-extension-runtime?" + new URLSearchParams({ tenant_id: "tenant", space_id: "space", project_id: "project-a", app_id: "not_a_canvas" })))).json())
      .toEqual({ managed: false, active: false, releaseValid: false });
  });

  it("keeps a composed Canvas bundle unavailable until its host initialization is confirmed", async () => {
    const storage = createDOStorage();
    const secret = "staged-canvas-runtime-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: secret } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','A','active')");
    const manifest = { id: "ext_staged_canvas", type: "extension", declaredPermissions: [], capabilityRequirements: ["extension.project_canvas"], gadgets: [], daemons: [], commands: [],
      bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_staged_canvas", version: "1.0.0", primitives: [
        { schemaVersion: "1.0", kind: "canvas", id: "canvas", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {}, layout: "CanvasMount", component: "./index.html", dynamicPage: false },
      ] } };
    const artifactSha256 = "d".repeat(64);
    const install = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest, installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND",
        gatekeeperCapabilities: ["extension.project_canvas"], artifactSha256, deferActivation: true }) }));
    expect(install.status).toBe(201);
    const { installationId } = await install.json() as { installationId: string };
    const visible = await space.fetch(new Request("http://space/extension-installations?tenant_id=tenant&space_id=space&extension_id=ext_staged_canvas"));
    expect(await visible.json()).toMatchObject({ installations: [{ status: "staging", project_id: "project-a" }] });
    const appRoute = () => space.fetch(new Request(`http://space/project-extension-runtime?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", project_id: "project-a", app_id: "canvas" })}`));
    expect(await (await appRoute()).json()).toEqual({ managed: true, active: false, releaseValid: false });

    const token = await mintInternalToken(secret, "tenant");
    const activate = (overrides: Record<string, unknown> = {}, authToken = token) => space.fetch(new Request("http://space/extension-installation/activate", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": authToken },
      body: JSON.stringify({ installationId, extensionId: "ext_staged_canvas", version: "1.0.0", artifactSha256, tenantId: "tenant", spaceId: "space", projectId: "project-a", ...overrides }),
    }));
    expect((await activate({}, "wrong-token")).status).toBe(403);
    expect((await activate({ projectId: "project-b" })).status).toBe(409);
    const abort = (projectId = "project-a") => space.fetch(new Request("http://space/extension-installation/abort", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
      body: JSON.stringify({ installationId, tenantId: "tenant", spaceId: "space", projectId }),
    }));
    await expect((await abort("project-b")).json()).resolves.toMatchObject({ aborted: false });
    expect(storage.sql.exec("SELECT status FROM extension_instances WHERE instance_id=?", installationId).toArray()[0]?.status).toBe("staging");
    expect((await activate()).status).toBe(200);
    expect(await (await appRoute()).json()).toEqual({ managed: true, active: true, releaseValid: true });
    expect((await activate()).status).toBe(200); // idempotent host retry
    expect(await (await abort()).json()).toMatchObject({ aborted: false });
  });

  it("preserves existing unscoped extension revision updates when no scoped grant exists", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, { PLATFORM_DB: planDb } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project"));
    const install = (value: unknown) => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: value, installedBy: "owner", tenantId: "tenant", gatekeeperCapabilities: ["native-execution"] }) }));
    expect((await install(manifest())).status).toBe(201);
    expect((await install(manifest("ffprobe"))).status).toBe(201);
    expect(storage.sql.exec("SELECT manifest_json FROM installed_extensions WHERE extension_id='ext_runtime_ffmpeg'").toArray()[0]?.manifest_json).toContain("ffprobe");
  });

  it("promotes project installations atomically to a Space extension installation", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, { PLATFORM_DB: planDb } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','A','active'),('project-b','space','B','active')");
    const install = (scope: string, projectId?: string, promoteExisting = false) => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: manifest(), installedBy: "owner", tenantId: "tenant", spaceId: "space", scope, projectId, promoteExisting, gatekeeperCapabilities: ["native-execution"] }) }));
    expect((await install("PROJECT_SHARED", "project-a")).status).toBe(201);
    expect((await install("PROJECT_SHARED", "project-b")).status).toBe(201);
    expect((await install("SPACE_SHARED", undefined, true)).status).toBe(201);
    const rows = storage.sql.exec("SELECT scope,status,project_id FROM extension_instances WHERE extension_id='ext_runtime_ffmpeg' ORDER BY scope,project_id").toArray();
    expect(rows.filter(row => row.status === "active")).toEqual([{ scope: "SPACE_SHARED", status: "active", project_id: null }]);
    expect(rows.filter(row => row.status === "removed")).toHaveLength(2);
    const lookup = await space.fetch(new Request("http://space/extension-installations?tenant_id=tenant&space_id=space&extension_id=ext_runtime_ffmpeg"));
    expect(await lookup.json()).toMatchObject({ installations: [{ scope: "SPACE_SHARED", project_id: null }] });
  });

  it("keeps Space Assistant runtime installs distinct from Space-shared extensions and project runs", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, { PLATFORM_DB: planDb } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id="));
    const install = (scope: string, projectId?: string) => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: manifest(), installedBy: "owner", tenantId: "tenant", spaceId: "space", scope, projectId, gatekeeperCapabilities: ["native-execution"] }) }));
    expect((await install("SPACE_SHARED")).status).toBe(201);
    expect((await install("SPACE_ASSISTANT")).status).toBe(201);
    expect(storage.sql.exec("SELECT scope,owner_key FROM extension_instances ORDER BY scope").toArray()).toEqual([
      { scope: "SPACE_ASSISTANT", owner_key: "space:space:assistant" }, { scope: "SPACE_SHARED", owner_key: "space:space" },
    ]);
    const assistant = await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id="));
    expect((await assistant.json() as { installations: Array<{ instance: { scope: string } }> }).installations.map(item => item.instance.scope).sort())
      .toEqual(["SPACE_ASSISTANT", "SPACE_SHARED"]);
    const projectRun = await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project"));
    expect((await projectRun.json() as { installations: Array<{ instance: { scope: string } }> }).installations.map(item => item.instance.scope))
      .toEqual(["SPACE_SHARED"]);
    expect((await install("SPACE_ASSISTANT", "project")).status).toBe(400);
  });
});


it("blocks runtime installs at the actor when subscription validation is unavailable or over plan", async () => {
  const request = (value = manifest()) => new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: value, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED", gatekeeperCapabilities: ["native-execution"] }) });
  const unavailable = new SpaceDO({ storage: createDOStorage() } as never, {} as never);
  expect((await unavailable.fetch(request())).status).toBe(503);
  const storage = createDOStorage();
  const space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb } as never);
  const oversized = manifest(); oversized.containers[0]!.resources.memoryMb = 12288;
  expect((await space.fetch(request(oversized))).status).toBe(403);
  expect(storage.sql.exec("SELECT COUNT(*) AS count FROM installed_extensions").toArray()[0]?.count).toBe(0);
  expect((await space.fetch(request())).status).toBe(201);
});

it("atomically caps concurrent installed runtimes by workspace subscription allowance", async () => {
  const storage = createDOStorage();
  const space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb } as never);
  const responses = await Promise.all(Array.from({ length: 24 }, (_, index) => {
    const value = manifest(); value.id = `ext_runtime_${index}`;
    return space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: value, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED", gatekeeperCapabilities: ["native-execution"] }) }));
  }));
  expect(responses.filter(response => response.status === 201)).toHaveLength(2);
  expect(storage.sql.exec("SELECT COUNT(*) AS count FROM extension_instances WHERE status='active'").toArray()[0]?.count).toBe(2);
});
