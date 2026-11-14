import { describe, expect, it } from "vitest";
import { SpaceDO } from "./SpaceDO.js";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { mintInternalToken } from "@naelao/http";
import { signHmac } from "@naelao/crypto";
import { digestExtensionManifest, PERSONAL_ASSISTANT_SPACE_TEMPLATE, validateExtensionManifest } from "@naelao/agent-sdk";

const planDb = { prepare: () => ({ bind: () => ({ first: async () => ({ plan_tier: "free" }) }) }) };

const image = "registry.example/media@sha256:" + "a".repeat(64);
function manifest(binary = "ffmpeg") {
  return { id: "ext_runtime_ffmpeg", type: "extension", declaredPermissions: ["container:execute"], capabilityRequirements: ["native-execution"],
    gadgets: [], daemons: [], commands: [], containers: [{ schemaVersion: "1.0", kind: "container", id: "ffmpeg", version: "1.0.0",
      permissions: [{ scope: "PROJECT_BOUND", actions: ["execute"], resource: "workspace" }], capabilityRequirements: ["native-execution"], lifecycle: {},
      image, resources: { memoryMb: 4096, cpuCores: 0.5, timeoutSeconds: 60 }, exportedBinaries: [binary], networkPolicy: "none" }] };
}

describe("runtime extension installation", () => {
  it("rechecks exact dependency closure at runtime and blocks removing an active dependency", async () => {
    const storage = createDOStorage(), secret = "extension-dependency-runtime-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: secret } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','A','active')");
    const released = (id: string, dependencies: unknown[] = []) => ({ id, type: "extension", declaredPermissions: [], capabilityRequirements: ["channel.invoke"],
      gadgets: [], daemons: [], commands: [], ...(dependencies.length ? { dependencies } : {}),
      bundle: { schemaVersion: "1.0", kind: "extension_bundle", id, version: "1.0.0", primitives: [
        { schemaVersion: "1.0", kind: "channel", id: "handler", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {},
          provider: "whatsapp", handlerScript: "./handler.ts", context: "channel_only", inboundEvents: ["message.received"], outboundEvents: ["message.reply"] },
      ] } });
    const dependencyManifest = validateExtensionManifest(released("ext_dependency"));
    const dependencyDigest = await digestExtensionManifest(dependencyManifest);
    const install = (manifest: unknown, deferActivation = false) => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest, installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND",
        gatekeeperCapabilities: ["channel.invoke"], artifactSha256: "a".repeat(64), deferActivation }) }));
    const dependencyInstall = await install(dependencyManifest);
    expect(dependencyInstall.status).toBe(201);
    const dependencyInstallationId = (await dependencyInstall.json() as { installationId: string }).installationId;
    const rootManifest = validateExtensionManifest(released("ext_dependency_root", [
      { extensionId: "ext_dependency", version: "1.0.0", manifestSha256: dependencyDigest },
    ]));
    const rootInstall = await install(rootManifest, true);
    expect(rootInstall.status, await rootInstall.clone().text()).toBe(201);
    const rootInstallationId = (await rootInstall.json() as { installationId: string }).installationId;
    const lookup = () => space.fetch(new Request("http://space/workflow-installation?" + new URLSearchParams({ instance_id: rootInstallationId, tenant_id: "tenant", space_id: "space" })));
    const token = await mintInternalToken(secret, "tenant");
    const activate = () => space.fetch(new Request("http://space/extension-installation/activate", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
      body: JSON.stringify({ installationId: rootInstallationId, extensionId: "ext_dependency_root", version: "1.0.0", artifactSha256: "a".repeat(64),
        tenantId: "tenant", spaceId: "space", scope: "PROJECT_BOUND", projectId: "project-a" }) }));
    storage.sql.exec("UPDATE extension_instances SET status='removed' WHERE instance_id=?", dependencyInstallationId);
    const blockedActivation = await activate();
    expect(blockedActivation.status).toBe(409);
    expect(await blockedActivation.json()).toMatchObject({ error_code: "staged_extension_dependency_unresolved" });
    storage.sql.exec("UPDATE extension_instances SET status='active',removed_at=NULL WHERE instance_id=?", dependencyInstallationId);
    expect((await activate()).status).toBe(200);
    expect(await (await lookup()).json()).toMatchObject({ dependenciesResolved: true, release: { signatureValid: true, dependenciesResolved: true } });

    const removeDependency = () => space.fetch(new Request("http://space/extension-installation?" + new URLSearchParams({ instance_id: dependencyInstallationId,
      tenant_id: "tenant", space_id: "space", project_id: "project-a" }), { method: "DELETE" }));
    const blockedRemoval = await removeDependency();
    expect(blockedRemoval.status).toBe(409);
    expect(await blockedRemoval.json()).toMatchObject({ error_code: "extension_required_by_installed_package", required_by: [rootInstallationId] });

    storage.sql.exec("UPDATE extension_instances SET status='removed' WHERE instance_id=?", dependencyInstallationId);
    expect(await (await lookup()).json()).toMatchObject({ dependenciesResolved: false, release: { signatureValid: true, dependenciesResolved: false } });
  });

  it("lists space-shared channel installations separately from project channel installations", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: "channel-list-secret" } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','A','active')");
    const channelManifest = (id: string) => ({ id, type: "extension", declaredPermissions: [], capabilityRequirements: ["channel.invoke"], gadgets: [], daemons: [], commands: [],
      bundle: { schemaVersion: "1.0", kind: "extension_bundle", id, version: "1.0.0", primitives: [
        { schemaVersion: "1.0", kind: "channel", id: "phone", version: "1.0.0", provider: "phone", handlerScript: "./phone.ts", context: "channel_only",
          permissions: [], capabilityRequirements: [], lifecycle: {}, inboundEvents: ["message.received"], outboundEvents: ["message.reply"] },
      ] } });
    const install = (id: string, scope: "SPACE_SHARED" | "PROJECT_BOUND") => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: channelManifest(id), installedBy: "owner", tenantId: "tenant", spaceId: "space", ...(scope === "PROJECT_BOUND" ? { projectId: "project-a" } : {}), scope, gatekeeperCapabilities: ["channel.invoke"], artifactSha256: "a".repeat(64) }) }));
    expect((await install("ext_space_phone", "SPACE_SHARED")).status).toBe(201);
    expect((await install("ext_project_phone", "PROJECT_BOUND")).status).toBe(201);

    const shared = await space.fetch(new Request("http://space/channel-installations?tenant_id=tenant&space_id=space"));
    expect(await shared.json()).toMatchObject({ installations: [expect.objectContaining({ extension_id: "ext_space_phone", scope: "SPACE_SHARED" })] });
    const project = await space.fetch(new Request("http://space/channel-installations?tenant_id=tenant&space_id=space&project_id=project-a"));
    expect(await project.json()).toMatchObject({ installations: [expect.objectContaining({ extension_id: "ext_project_phone", scope: "PROJECT_BOUND" })] });
  });

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
    const firstResult = await first.json() as { installationId: string };
    const installationId = firstResult.installationId;
    const retry = await call("1.0.0");
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ installationId });
    expect(firstResult).toMatchObject({ release: { version: "1.0.0", artifactSha256: "a".repeat(64), signer: "naelao-host", hostSignature: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect((await call("2.0.0")).status).toBe(409);
    expect((await call("2.0.0", true)).status).toBe(409);
    expect(storage.sql.exec("SELECT release_version FROM extension_instances WHERE instance_id=?", installationId).toArray())
      .toEqual([{ release_version: "1.0.0" }]);
    const token = await mintInternalToken("release-test-secret", "tenant");
    const leaseRequest = (action: "acquire" | "release") => space.fetch(new Request("http://space/extension-runtime-work", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-internal-token": token },
      body: JSON.stringify({ action, tenantId: "tenant", spaceId: "space", projectId: "project-a", instanceId: installationId,
        workId: "update-race", workKind: "channel" }) }));
    expect((await leaseRequest("acquire")).status).toBe(200);
    storage.sql.exec("UPDATE extension_instances SET status='disabled' WHERE instance_id=?", installationId);
    const undrainedUpgrade = await call("2.0.0", true);
    expect(undrainedUpgrade.status).toBe(409);
    expect(await undrainedUpgrade.json()).toMatchObject({ error: "extension_runtime_work_not_drained" });
    await leaseRequest("release");
    expect((await call("2.0.0", true)).status).toBe(201);
    const releases = await space.fetch(new Request("http://space/extension-releases?extension_id=ext_versioned"));
    expect(await releases.json()).toMatchObject({ releases: expect.arrayContaining([
      expect.objectContaining({ version: "2.0.0", signatureValid: true }), expect.objectContaining({ version: "1.0.0", signatureValid: true }),
    ]) });
    const rollbackRequest = () => space.fetch(new Request("http://space/extension-releases/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      extensionId: "ext_versioned", version: "1.0.0", installationId, tenantId: "tenant", spaceId: "space", projectId: "project-a", expectedCurrentVersion: "2.0.0",
    }) }));
    expect((await rollbackRequest()).status).toBe(409);
    storage.sql.exec("UPDATE extension_instances SET status='disabled' WHERE instance_id=?", installationId);
    const rollback = await rollbackRequest();
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({ rolledBack: true, manifest: { bundle: { version: "1.0.0" } } });
    const runtime = await space.fetch(new Request("http://space/workflow-installation?" + new URLSearchParams({ instance_id: installationId, tenant_id: "tenant", space_id: "space", include_disabled: "1" })));
    expect(await runtime.json()).toMatchObject({ manifest: { bundle: { version: "1.0.0" } } });
  });

  it("keeps sibling project installs on their pinned release when one instance upgrades", async () => {
    const storage = Object.assign(createDOStorage(), { get: async () => undefined }), state = { storage };
    const space = new SpaceDO(state as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: "release-pin-test-secret" } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','A','active'),('project-b','space','B','active'),('project-c','space','C','active')");
    const bundleManifest = (version: string) => ({ id: "ext_pinned", type: "extension", declaredPermissions: [], capabilityRequirements: ["channel.invoke"], gadgets: [], daemons: [], commands: [],
      bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_pinned", version, primitives: [{ schemaVersion: "1.0", kind: "channel", id: "handler", version, permissions: [], capabilityRequirements: [], lifecycle: {}, provider: "whatsapp", handlerScript: "./handler.ts", context: "channel_only", inboundEvents: ["message.received"], outboundEvents: ["message.reply"] }] } });
    const install = (projectId: string, version: string, upgrade = false) => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: bundleManifest(version), installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId, scope: "PROJECT_BOUND", gatekeeperCapabilities: ["channel.invoke"], artifactSha256: version.startsWith("1") ? "1".repeat(64) : "2".repeat(64), upgrade }) }));
    expect((await install("project-a", "1.0.0")).status).toBe(201);
    expect((await install("project-b", "1.0.0")).status).toBe(201);
    storage.sql.exec("UPDATE extension_instances SET status='disabled' WHERE extension_id='ext_pinned' AND project_id='project-a'");
    expect((await install("project-a", "2.0.0", true)).status).toBe(201);
    storage.sql.exec("UPDATE extension_instances SET status='disabled' WHERE extension_id='ext_pinned' AND project_id='project-b'");
    expect((await install("project-b", "2.0.0", true)).status).toBe(201);
    const lookup = (projectId: string) => space.fetch(new Request("http://space/channel-installations?tenant_id=tenant&space_id=space&project_id=" + projectId));
    expect(await (await lookup("project-a")).json()).toMatchObject({ installations: [{ version: "2.0.0" }] });
    expect(await (await lookup("project-b")).json()).toMatchObject({ installations: [{ version: "2.0.0" }] });
    expect((await install("project-c", "1.0.0")).status).toBe(201);
    expect(await (await lookup("project-c")).json()).toMatchObject({ installations: [{ version: "1.0.0" }] });
    const projectAInstances = await space.fetch(new Request("http://space/extension-installations?tenant_id=tenant&space_id=space&extension_id=ext_pinned"));
    const projectAInstall = (await projectAInstances.json() as { installations: Array<{ instance_id: string; project_id: string | null; release_version: string | null }> }).installations
      .find(item => item.project_id === "project-a");
    expect(projectAInstall).toBeDefined();
    const rollbackFor = (tenantId: string, expectedCurrentVersion: string | null) => space.fetch(new Request("http://space/extension-releases/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      extensionId: "ext_pinned", version: "1.0.0", installationId: projectAInstall!.instance_id, tenantId, spaceId: "space", projectId: "project-a", expectedCurrentVersion,
    }) }));
    expect((await rollbackFor("other-tenant", "2.0.0")).status).toBe(404);
    expect((await rollbackFor("tenant", "1.0.0")).status).toBe(409);
    const rollback = await space.fetch(new Request("http://space/extension-releases/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      extensionId: "ext_pinned", version: "1.0.0", installationId: projectAInstall!.instance_id, tenantId: "tenant", spaceId: "space", projectId: "project-a", expectedCurrentVersion: "2.0.0",
    }) }));
    expect(rollback.status).toBe(409);
    storage.sql.exec("UPDATE extension_instances SET status='disabled' WHERE instance_id=?", projectAInstall!.instance_id);
    const confirmedRollback = await space.fetch(new Request("http://space/extension-releases/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      extensionId: "ext_pinned", version: "1.0.0", installationId: projectAInstall!.instance_id, tenantId: "tenant", spaceId: "space", projectId: "project-a", expectedCurrentVersion: "2.0.0",
    }) }));
    expect(confirmedRollback.status).toBe(200);
    expect(await (await lookup("project-b")).json()).toMatchObject({ installations: [{ version: "2.0.0" }] });
    const inventory = await space.fetch(new Request("http://space/extension-installations?tenant_id=tenant&space_id=space&extension_id=ext_pinned"));
    expect(await inventory.json()).toMatchObject({ installations: expect.arrayContaining([
      expect.objectContaining({ project_id: "project-a", release_version: "1.0.0" }),
      expect.objectContaining({ project_id: "project-b", release_version: "2.0.0" }),
    ]) });
    const template = await space.exportBlueprint("space", { projectId: "project-b", requiredExtensions: ["ext_pinned"], requiredExtensionVersions: { ext_pinned: "1.0.0" } });
    expect(template.requiredExtensionVersions).toEqual({ ext_pinned: "1.0.0" });
    expect(template.requiredExtensionDigests?.ext_pinned).toMatch(/^[a-f0-9]{64}$/);
    const multiProjectTemplate = await space.exportBlueprint("space", { projectIds: ["project-a", "project-b"], requiredExtensions: [] });
    expect(multiProjectTemplate.projects.map(project => project.id)).toEqual(["project-a", "project-b"]);
    await expect(space.exportBlueprint("space", { projectIds: ["project-a", "missing-project"] })).rejects.toThrow("project_not_found");
    await expect(space.exportBlueprint("space", { projectIds: ["project-a", "project-a"] })).rejects.toThrow("invalid_project_ids");
    await expect(space.exportBlueprint("space", { projectId: "project-b", requiredExtensions: ["ext_pinned"], requiredExtensionVersions: { ext_pinned: "3.0.0" } }))
      .rejects.toThrow("required_extension_release_unavailable");
    const unavailable = await space.fetch(new Request("http://space/blueprints/export", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ space_id: "space", project_id: "project-b", required_extensions: ["ext_pinned"], required_extension_versions: { ext_pinned: "3.0.0" } }) }));
    expect(unavailable.status).toBe(422);
    expect(await unavailable.json()).toMatchObject({ error_code: "required_extension_release_unavailable" });
  });

  it("binds publisher identity to immutable releases and blocks a revoked publisher release", async () => {
    const storage = createDOStorage(), state = { storage }, secret = "publisher-test-secret";
    let space = new SpaceDO(state as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: secret } as never);
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
    const lookup = () => space.fetch(new Request("http://space/workflow-installation?" + new URLSearchParams({ instance_id: instanceId, tenant_id: "tenant", space_id: "space", include_disabled: "1" })));
    expect(await (await lookup()).json()).toMatchObject({ release: { signatureValid: true, publisher: { id: "pub_example", keyId: "a".repeat(64), revoked: false } } });
    storage.sql.exec("UPDATE extension_releases SET publisher_key_id=NULL WHERE extension_id='ext_publisher_lifecycle' AND version='1.0.0'");
    expect(await (await lookup()).json()).toMatchObject({ release: { signatureValid: false, publisher: { id: "pub_example", keyId: null } } });
    storage.sql.exec("UPDATE extension_releases SET publisher_key_id=? WHERE extension_id='ext_publisher_lifecycle' AND version='1.0.0'", "a".repeat(64));
    const token = await mintInternalToken(secret, "tenant");
    const work = (action: "acquire" | "release", workId: string) => space.fetch(new Request("http://space/extension-runtime-work", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": token },
      body: JSON.stringify({ action, tenantId: "tenant", spaceId: "space", projectId: "project-a", instanceId, workId, workKind: "channel" }),
    }));
    expect((await work("acquire", "before-revoke")).status).toBe(200);
    const revokeRequest = (headers: HeadersInit = { "content-type": "application/json", "x-naelao-internal-token": token }) => space.fetch(new Request("http://space/extension-publisher-revoke", {
      method: "POST", headers, body: JSON.stringify({ tenantId: "tenant", spaceId: "space", keyId: "a".repeat(64), actorId: "owner" }),
    }));
    expect((await revokeRequest({ "content-type": "application/json" })).status).toBe(403);
    const revoke = await revokeRequest();
    expect(revoke.status).toBe(202);
    expect(await revoke.json()).toMatchObject({ revoked: true, changed: true, state: "draining", active_work_count: 1,
      disabled_installation_count: 1, new_work_denied: true, admitted_work_policy: "allowed_to_finish" });
    space = new SpaceDO(state as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: secret } as never);
    expect(await (await lookup()).json()).toMatchObject({ release: { signatureValid: false, publisher: { revoked: true } } });
    expect(storage.sql.exec("SELECT status FROM extension_instances WHERE instance_id=?", instanceId).toArray()).toEqual([{ status: "disabled" }]);
    const reenable = await space.fetch(new Request("http://space/project-extension-lifecycle", { method: "PATCH",
      headers: { "content-type": "application/json", "x-naelao-internal-token": token },
      body: JSON.stringify({ tenantId: "tenant", spaceId: "space", projectId: "project-a", instanceId, action: "enable" }) }));
    expect(reenable.status).toBe(409);
    expect(await reenable.json()).toMatchObject({ error_code: "extension_publisher_key_revoked" });
    const afterRevoke = await work("acquire", "after-revoke");
    expect(afterRevoke.status).toBe(409);
    expect(await afterRevoke.json()).toMatchObject({ error_code: "extension_installation_inactive" });
    expect(await (await install()).json()).toMatchObject({ error: "extension_publisher_key_revoked" });
    expect(await (await work("release", "before-revoke")).json()).toMatchObject({ released: true, status: "released" });
    const receiptRead = (spaceId: string, tokenValue = token) => space.fetch(new Request(`http://space/extension-publisher-revocation?${new URLSearchParams({
      tenant_id: "tenant", space_id: spaceId, key_id: "a".repeat(64),
    })}`, { headers: { "x-naelao-internal-token": tokenValue } }));
    expect((await receiptRead("space", await mintInternalToken(secret, "other-tenant"))).status).toBe(403);
    expect((await receiptRead("other-space")).status).toBe(404);
    const readback = await receiptRead("space");
    expect(readback.status).toBe(200);
    expect(await readback.json()).toMatchObject({ receipt: { tenant_id: "tenant", space_id: "space", key_id: "a".repeat(64),
      status: "drained", active_work_count: 0, revoked_by: "owner" } });
    const drained = await revokeRequest();
    expect(drained.status).toBe(200);
    expect(await drained.json()).toMatchObject({ changed: false, state: "drained", active_work_count: 0, revoked_release_count: 1,
      disabled_installation_count: 1 });
    expect(storage.sql.exec("SELECT status,active_work_count FROM extension_publisher_revocation_receipts WHERE key_id=?", "a".repeat(64)).toArray())
      .toEqual([{ status: "drained", active_work_count: 0 }]);
    const rollback = await space.fetch(new Request("http://space/extension-releases/rollback", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ extensionId: "ext_publisher_lifecycle", version: "1.0.0", installationId: instanceId, tenantId: "tenant", spaceId: "space", projectId: "project-a", expectedCurrentVersion: "1.0.0" }) }));
    expect(rollback.status).toBe(409);
  });

  it("requires an explicit acknowledgement before a scoped rollback expands permissions", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: "release-expansion-secret" } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','A','active')");
    const bundleManifest = (version: string, capabilities: string[]) => ({ id: "ext_access_review", type: "extension", declaredPermissions: capabilities, capabilityRequirements: capabilities, gadgets: [], daemons: [], commands: [],
      bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_access_review", version, primitives: [{ schemaVersion: "1.0", kind: "channel", id: "handler", version, permissions: [], capabilityRequirements: [], lifecycle: {}, provider: "telegram", handlerScript: "./handler.ts", context: "channel_only", inboundEvents: ["message.received"], outboundEvents: ["message.reply"] }] } });
    const install = (version: string, capabilities: string[], upgrade = false) => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: bundleManifest(version, capabilities), installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND", gatekeeperCapabilities: capabilities,
        artifactSha256: version === "2.0.0" ? "2".repeat(64) : version === "1.0.0" ? "1".repeat(64) : "3".repeat(64), upgrade }) }));
    const first = await install("1.0.0", ["channel.invoke"]);
    expect(first.status, await first.clone().text()).toBe(201);
    const instanceId = String(storage.sql.exec("SELECT instance_id FROM extension_instances WHERE extension_id='ext_access_review'").toArray()[0]?.instance_id);
    storage.sql.exec("UPDATE extension_instances SET status='disabled' WHERE instance_id=?", instanceId);
    expect((await install("2.0.0", ["channel.invoke", "repo.read"], true)).status).toBe(201);
    storage.sql.exec("UPDATE extension_instances SET status='disabled' WHERE instance_id=?", instanceId);
    expect((await install("3.0.0", ["channel.invoke"], true)).status).toBe(201);
    const result = await space.fetch(new Request("http://space/extension-installations?tenant_id=tenant&space_id=space&extension_id=ext_access_review"));
    const installation = (await result.json() as { installations: Array<{ instance_id: string }> }).installations[0]!;
    storage.sql.exec("UPDATE extension_instances SET status='disabled' WHERE instance_id=?", installation.instance_id);
    const rollback = (approved: boolean) => space.fetch(new Request("http://space/extension-releases/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      extensionId: "ext_access_review", version: "2.0.0", installationId: installation.instance_id, tenantId: "tenant", spaceId: "space", projectId: "project-a",
      expectedCurrentVersion: "3.0.0", permissionExpansionApproved: approved,
    }) }));
    const denied = await rollback(false);
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: "permission_expansion_approval_required", added_permissions: ["repo.read"], added_capabilities: ["repo.read"] });
    expect((await rollback(true)).status).toBe(200);
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

  it("serializes concurrent runtime admission with pause, replays lost lease responses, and drains after restart", async () => {
    const storage = createDOStorage(), secret = "runtime-work-lease-secret";
    let space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: secret } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id="));
    const shared = { id: "ext_runtime_work", type: "extension", declaredPermissions: [], capabilityRequirements: ["space.shared.read"],
      gadgets: [{ id: "runtime_app", name: "Runtime app", viewportComponent: "./app.ts", scope: "SPACE_SHARED", gadgetTier: 3, defaultSchemaSql: "" }],
      daemons: [], commands: [] };
    const installed = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: shared, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED", gatekeeperCapabilities: ["space.shared.read"] }) }));
    expect(installed.status, await installed.clone().text()).toBe(201);
    const { installationId } = await installed.json() as { installationId: string };
    const token = await mintInternalToken(secret, "tenant");
    const work = (action: "acquire" | "release" | "status", workId: string) => space.fetch(new Request("http://space/extension-runtime-work", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": token },
      body: JSON.stringify({ action, tenantId: "tenant", spaceId: "space", projectId: null, instanceId: installationId, workId, workKind: "gadget" }),
    }));

    const concurrent = await Promise.all([work("acquire", "work-a"), work("acquire", "work-b")]);
    expect(concurrent.map(response => response.status)).toEqual([200, 200]);
    expect(await (await work("acquire", "work-a")).json()).toMatchObject({ acquired: true, replayed: true });

    space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: secret } as never);
    expect(await (await work("status", "status-check")).json()).toMatchObject({ active_work_count: 2, drained: false });
    const paused = await space.fetch(new Request("http://space/space-shared-extension-lifecycle", { method: "PATCH",
      headers: { "content-type": "application/json", "x-naelao-internal-token": token },
      body: JSON.stringify({ tenantId: "tenant", spaceId: "space", instanceId: installationId, action: "disable", drainTimeoutMs: 0 }) }));
    expect(paused.status).toBe(202);
    expect(await paused.json()).toMatchObject({ status: "disabled", drained: false, active_work_count: 2 });
    expect((await work("acquire", "work-c")).status).toBe(409);
    expect(await (await work("release", "work-a")).json()).toMatchObject({ released: true, status: "released" });
    expect(await (await work("release", "work-a")).json()).toMatchObject({ released: true, status: "released" });
    expect(await (await work("status", "status-check")).json()).toMatchObject({ active_work_count: 1, drained: false });
    await work("release", "work-b");
    expect(await (await space.fetch(new Request("http://space/extension-runtime-work", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-internal-token": token },
      body: JSON.stringify({ action: "status", tenantId: "tenant", spaceId: "space", projectId: null,
        instanceId: installationId, workId: "status-check", workKind: "gadget" }) }))).json()).toMatchObject({ active_work_count: 0, drained: true });
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
    const duplicateInstall = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: manifest(), installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND", gatekeeperCapabilities: ["native-execution"] }) }));
    expect(duplicateInstall.status).toBe(201);
    expect(storage.sql.exec("SELECT status FROM extension_instances WHERE instance_id=?", installationId).toArray()).toEqual([{ status: "disabled" }]);
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
    const activeUpgrade = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: canvasManifest("2.0.0", "renamed_canvas"), installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND", gatekeeperCapabilities: ["extension.project_canvas"], artifactSha256: "b".repeat(64), upgrade: true }) }));
    expect(activeUpgrade.status).toBe(409);
    storage.sql.exec("UPDATE extension_instances SET status='disabled' WHERE instance_id=?", installed.installationId);
    const upgrade = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: canvasManifest("2.0.0", "renamed_canvas"), installedBy: "owner", tenantId: "tenant", spaceId: "space", projectId: "project-a", scope: "PROJECT_BOUND", gatekeeperCapabilities: ["extension.project_canvas"], artifactSha256: "b".repeat(64), upgrade: true }) }));
    expect(upgrade.status).toBe(201);
    expect(await (await check("mentor_canvas")).json()).toEqual({ managed: true, active: false, releaseValid: false, dependenciesResolved: false });
    expect(await (await check("renamed_canvas")).json()).toEqual({ managed: true, active: true, releaseValid: true, dependenciesResolved: true,
      installationId: "installation:tenant:ext_canvas_runtime:space:space:project:project-a:bound" });
    const removed = await space.fetch(new Request("http://space/extension-installation?" + new URLSearchParams({ instance_id: installed.installationId, tenant_id: "tenant", space_id: "space", project_id: "project-a" }), { method: "DELETE" }));
    expect(removed.status).toBe(200);
    expect(await (await check("mentor_canvas")).json()).toEqual({ managed: true, active: false, releaseValid: false, dependenciesResolved: false });
    expect(await (await check("renamed_canvas")).json()).toEqual({ managed: true, active: false, releaseValid: false, dependenciesResolved: false });
    expect(await (await space.fetch(new Request("http://space/project-extension-runtime?" + new URLSearchParams({ tenant_id: "tenant", space_id: "space", project_id: "project-a", app_id: "not_a_canvas" })))).json())
      .toEqual({ managed: false, active: false, releaseValid: false, dependenciesResolved: false });
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
    expect(await (await appRoute()).json()).toEqual({ managed: true, active: false, releaseValid: false, dependenciesResolved: false });

    const token = await mintInternalToken(secret, "tenant");
    const activate = (overrides: Record<string, unknown> = {}, authToken = token) => space.fetch(new Request("http://space/extension-installation/activate", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": authToken },
      body: JSON.stringify({ installationId, extensionId: "ext_staged_canvas", version: "1.0.0", artifactSha256, tenantId: "tenant", spaceId: "space", scope: "PROJECT_BOUND", projectId: "project-a", ...overrides }),
    }));
    expect((await activate({}, "wrong-token")).status).toBe(403);
    expect((await activate({ projectId: "project-b" })).status).toBe(409);
    const abort = (projectId = "project-a") => space.fetch(new Request("http://space/extension-installation/abort", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
      body: JSON.stringify({ installationId, tenantId: "tenant", spaceId: "space", scope: "PROJECT_BOUND", projectId }),
    }));
    await expect((await abort("project-b")).json()).resolves.toMatchObject({ aborted: false });
    expect(storage.sql.exec("SELECT status FROM extension_instances WHERE instance_id=?", installationId).toArray()[0]?.status).toBe("staging");
    expect((await activate()).status).toBe(200);
    expect(await (await appRoute()).json()).toEqual({ managed: true, active: true, releaseValid: true, dependenciesResolved: true,
      installationId: "installation:tenant:ext_staged_canvas:space:space:project:project-a:bound" });
    expect((await activate()).status).toBe(200); // idempotent host retry
    expect(await (await abort()).json()).toMatchObject({ aborted: false });
  });

  it("stages and activates a signed Space-shared package without accepting a project scope", async () => {
    const storage = createDOStorage(), secret = "shared-package-activation-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: secret } as never);
    const artifactSha256 = "e".repeat(64);
    const manifest = { id: "ext_shared_package", type: "extension", declaredPermissions: ["assistant.phone.read", "assistant.phone.simulate"], capabilityRequirements: ["extension.project_canvas", "assistant.phone.read", "assistant.phone.simulate"],
      gadgets: [], daemons: [], commands: [], bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_shared_package", version: "1.0.0",
        primitives: [{ schemaVersion: "1.0", kind: "canvas", id: "dashboard", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {},
          component: "./dashboard.html", layout: "CanvasMount", dynamicPage: false },
          { schemaVersion: "1.0", kind: "channel", id: "phone", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {},
            provider: "phone", handlerScript: "./handler.ts", context: "channel_only", inboundEvents: ["message.received", "call.received", "call.digits"],
            outboundEvents: ["message.reply", "voice.reply"] }] } };
    const install = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED",
        gatekeeperCapabilities: ["extension.project_canvas", "assistant.phone.read", "assistant.phone.simulate"], artifactSha256, publisherId: "pub_example", publisherKeyId: "a".repeat(64),
        publisherSignature: "publisher-signature", publisherPayloadSha256: "b".repeat(64), deferActivation: true }) }));
    expect(install.status, JSON.stringify(await install.clone().json())).toBe(201);
    const { installationId, release } = await install.json() as { installationId: string; release: { hostSignature: string } };
    const catalog = await space.fetch(new Request("http://space/extension-package-catalog"));
    expect(await catalog.json()).toMatchObject({ releases: [{ extension_id: "ext_shared_package", version: "1.0.0", has_canvas: true,
      name: "dashboard", publisher: { id: "pub_example", key_id: "a".repeat(64) } }] });
    const packageRelease = await space.fetch(new Request("http://space/extension-package-release?extension_id=ext_shared_package&version=1.0.0"));
    expect(await packageRelease.json()).toMatchObject({ release: { extension_id: "ext_shared_package", version: "1.0.0",
      manifest, manifest_json: expect.stringContaining('"provider":"phone"'), artifact_sha256: artifactSha256,
      publisher: { id: "pub_example", key_id: "a".repeat(64) } } });

    const token = await mintInternalToken(secret, "tenant");
    const activate = (body: Record<string, unknown>) => space.fetch(new Request("http://space/extension-installation/activate", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
      body: JSON.stringify({ installationId, extensionId: "ext_shared_package", version: "1.0.0", artifactSha256,
        tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED", ...body }),
    }));
    expect((await activate({ artifactSha256: "f".repeat(64) })).status).toBe(409);
    const staged = await space.fetch(new Request("http://space/extension-installations?tenant_id=tenant&space_id=space&extension_id=ext_shared_package&include_manifest=1"));
    expect(await staged.json()).toMatchObject({ installations: [{ status: "staging", scope: "SPACE_SHARED", project_id: null,
      manifest: { bundle: { version: "1.0.0" } } }] });
    expect((await activate({})).status).toBe(200);
    expect((await activate({})).status).toBe(200);
    expect(await space.fetch(new Request("http://space/space-shared-extensions?tenant_id=tenant&space_id=space"))
      .then(response => response.json())).toMatchObject({ apps: [{ app_id: "dashboard", extension_id: "ext_shared_package", status: "active", release_version: "1.0.0" }] });
    const runtime = () => space.fetch(new Request("http://space/space-shared-extension-runtime?tenant_id=tenant&space_id=space&app_id=dashboard"));
    expect(await runtime().then(response => response.json())).toMatchObject({ managed: true, active: true, releaseValid: true,
      publisherKeyId: "a".repeat(64), publisherId: "pub_example", releaseVersion: "1.0.0",
      installationId, extensionId: "ext_shared_package", phoneChannel: true,
      phoneDashboardAllowed: true, phoneSimulationAllowed: true });
    storage.sql.exec("UPDATE extension_releases SET publisher_revoked_at='revoked' WHERE extension_id='ext_shared_package' AND version='1.0.0'");
    expect(await runtime().then(response => response.json())).toMatchObject({ managed: true, active: false, releaseValid: false });
    const abort = await space.fetch(new Request("http://space/extension-installation/abort", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
      body: JSON.stringify({ installationId, tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED" }) }));
    expect(await abort.json()).toMatchObject({ aborted: false });
    expect(release.hostSignature).toMatch(/^[a-f0-9]{64}$/);
  });

  it("applies only paused version-compatible Canvas and channel-code updates atomically and replays the durable receipt", async () => {
    const storage = createDOStorage(), secret = "space-shared-update-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: secret } as never);
    const token = await mintInternalToken(secret, "tenant"), publisherKeyId = "d".repeat(64);
    const canvasManifest = (version: string) => validateExtensionManifest({ id: "ext_static_canvas", type: "extension", declaredPermissions: [],
      capabilityRequirements: ["extension.project_canvas"], gadgets: [], daemons: [], commands: [],
      bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_static_canvas", version, primitives: [
        { schemaVersion: "1.0", kind: "canvas", id: "dashboard", version, permissions: [], capabilityRequirements: [], lifecycle: {},
          component: "./dashboard.html", layout: "CanvasMount", dynamicPage: false },
        { schemaVersion: "1.0", kind: "channel", id: "phone_handler", version, permissions: [], capabilityRequirements: [], lifecycle: {},
          provider: "phone", handlerScript: "./handler.ts", context: "channel_only", inboundEvents: ["message.received", "call.received", "call.digits"], outboundEvents: ["message.reply", "voice.reply"] },
      ] } }, { gatekeeperCapabilities: ["extension.project_canvas"] });
    const currentManifest = canvasManifest("1.0.0"), candidateManifest = canvasManifest("1.2.0");
    const install = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: currentManifest, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED",
        gatekeeperCapabilities: ["extension.project_canvas"], artifactSha256: "a".repeat(64), publisherId: "pub_example", publisherKeyId,
        publisherSignature: "signed-current-release", publisherPayloadSha256: "b".repeat(64) }) }));
    expect(install.status, await install.clone().text()).toBe(201);
    const { installationId } = await install.json() as { installationId: string };
    const importCandidate = await space.fetch(new Request("http://space/extension-package-release/import", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
      body: JSON.stringify({ tenantId: "tenant", spaceId: "space", importedBy: "owner", extensionId: candidateManifest.id,
        version: "1.2.0", manifestJson: JSON.stringify(candidateManifest), artifactSha256: "c".repeat(64), publisherId: "pub_example",
        publisherKeyId, publisherSignature: "signed-candidate-release", publisherPayloadSha256: "e".repeat(64) }) }));
    expect(importCandidate.status).toBe(201);
    const limitedReleases = await space.fetch(new Request("http://space/extension-releases?extension_id=ext_static_canvas&limit=1"));
    expect((await limitedReleases.json() as { releases: unknown[] }).releases).toHaveLength(1);
    expect((await space.fetch(new Request("http://space/extension-releases?extension_id=ext_static_canvas&limit=0"))).status).toBe(400);
    const acquireLease = () => space.fetch(new Request("http://space/extension-runtime-work", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-internal-token": token },
      body: JSON.stringify({ action: "acquire", tenantId: "tenant", spaceId: "space", projectId: null,
        instanceId: installationId, workId: "canvas-in-flight", workKind: "gadget" }) }));
    expect((await acquireLease()).status).toBe(200);
    const paused = await space.fetch(new Request("http://space/space-shared-extension-lifecycle", { method: "PATCH",
      headers: { "content-type": "application/json", "x-naelao-internal-token": token },
      body: JSON.stringify({ tenantId: "tenant", spaceId: "space", instanceId: installationId, action: "disable" }) }));
    expect(paused.status).toBe(202);
    expect(await paused.json()).toMatchObject({ status: "disabled", drained: false, active_work_count: 1 });

    const claims = { version: 1, purpose: "space_shared_extension_update", tenantId: "tenant", spaceId: "space", actorId: "owner",
      installationId, extensionId: candidateManifest.id, fromVersion: "1.0.0", toVersion: "1.2.0", artifactSha256: "c".repeat(64),
      publisherId: "pub_example", publisherKeyId, expiresAt: Date.now() + 60_000, requestId: "0ab3a7cc-4f8d-4a6b-8f9f-6a5f86b458ed" };
    const claimsPayload = JSON.stringify(claims);
    const reviewToken = `${btoa(claimsPayload).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}.${await signHmac(claimsPayload, secret)}`;
    const apply = () => space.fetch(new Request("http://space/space-shared-extension-update", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
      body: JSON.stringify({ tenantId: "tenant", spaceId: "space", actorId: "owner", claims, reviewToken }) }));
    const blockedByWork = await apply();
    expect(blockedByWork.status).toBe(409);
    expect(await blockedByWork.json()).toMatchObject({ error_code: "extension_runtime_work_not_drained" });
    await space.fetch(new Request("http://space/extension-runtime-work", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-internal-token": token },
      body: JSON.stringify({ action: "release", tenantId: "tenant", spaceId: "space", projectId: null,
        instanceId: installationId, workId: "canvas-in-flight", workKind: "gadget" }) }));
    const first = await apply();
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json() as { receipt: { request_id: string; created_at: string }; replayed: boolean };
    expect(firstBody).toMatchObject({ replayed: false, receipt: { request_id: claims.requestId } });
    expect(storage.sql.exec<{ release_version: string; status: string }>("SELECT release_version,status FROM extension_instances WHERE instance_id=?", installationId).toArray())
      .toEqual([{ release_version: "1.2.0", status: "disabled" }]);
    const replay = await apply();
    expect(await replay.json()).toMatchObject({ updated: true, replayed: true, receipt: { request_id: claims.requestId, created_at: firstBody.receipt.created_at } });
    expect(storage.sql.exec("SELECT request_id FROM space_shared_extension_update_receipts WHERE installation_id=?", installationId).toArray())
      .toEqual([{ request_id: claims.requestId }]);
    const history = await space.fetch(new Request("http://space/space-shared-extension-updates?tenant_id=tenant&space_id=space", {
      headers: { "x-naelao-internal-token": token },
    }));
    expect(await history.json()).toMatchObject({ receipts: [{ request_id: claims.requestId, installation_id: installationId,
      from_version: "1.0.0", to_version: "1.2.0", actor_id: "owner" }] });
    const receiptLookup = await space.fetch(new Request(`http://space/space-shared-extension-update-receipt?${new URLSearchParams({
      tenant_id: "tenant", space_id: "space", request_id: claims.requestId,
    })}`, { headers: { "x-naelao-internal-token": token } }));
    expect(await receiptLookup.json()).toMatchObject({ receipt: { request_id: claims.requestId, installation_id: installationId } });
    const unauthenticatedHistory = await space.fetch(new Request("http://space/space-shared-extension-updates?tenant_id=tenant&space_id=space"));
    expect(unauthenticatedHistory.status).toBe(403);

    const rollbackClaims = { ...claims, fromVersion: "1.2.0", toVersion: "1.0.0", artifactSha256: "a".repeat(64),
      expiresAt: Date.now() + 60_000, requestId: "43f83d14-14df-4c9a-a0a5-07ccf87a5d82" };
    const rollbackPayload = JSON.stringify(rollbackClaims);
    const rollbackToken = btoa(rollbackPayload).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
      + "." + await signHmac(rollbackPayload, secret);
    const rollback = await space.fetch(new Request("http://space/space-shared-extension-update", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
      body: JSON.stringify({ tenantId: "tenant", spaceId: "space", actorId: "owner", claims: rollbackClaims, reviewToken: rollbackToken }) }));
    expect(rollback.status, await rollback.clone().text()).toBe(200);
    expect(await rollback.json()).toMatchObject({ updated: true, replayed: false, receipt: { from_version: "1.2.0", to_version: "1.0.0" } });
    expect(storage.sql.exec<{ release_version: string; status: string }>("SELECT release_version,status FROM extension_instances WHERE instance_id=?", installationId).toArray())
      .toEqual([{ release_version: "1.0.0", status: "disabled" }]);
  });

  it("imports publisher-attested release metadata idempotently and rejects immutable conflicts", async () => {
    const storage = createDOStorage(), secret = "cross-space-package-import-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_DB: planDb, PLATFORM_SECRET: secret } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=destination"));
    const manifest = validateExtensionManifest({ id: "ext_imported_package", type: "extension", declaredPermissions: [],
      capabilityRequirements: ["extension.project_canvas"], gadgets: [], daemons: [], commands: [], bundle: { schemaVersion: "1.0",
        kind: "extension_bundle", id: "ext_imported_package", version: "1.0.0", primitives: [{ schemaVersion: "1.0", kind: "canvas",
          id: "dashboard", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {}, component: "./dashboard.html",
          layout: "CanvasMount", dynamicPage: false }] } }, { gatekeeperCapabilities: ["extension.project_canvas"] });
    const manifestJson = JSON.stringify(manifest), artifactSha256 = "a".repeat(64), token = await mintInternalToken(secret, "tenant");
    const importRequest = (overrides: Record<string, unknown> = {}, authToken = token) => space.fetch(new Request("http://space/extension-package-release/import", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": authToken },
      body: JSON.stringify({ tenantId: "tenant", spaceId: "destination", importedBy: "owner", extensionId: manifest.id, version: "1.0.0",
        manifestJson, artifactSha256, publisherId: "pub_example", publisherKeyId: "b".repeat(64), publisherSignature: "publisher-signature",
        publisherPayloadSha256: "c".repeat(64), ...overrides }),
    }));
    expect((await importRequest({}, "invalid-token")).status).toBe(403);
    const first = await importRequest();
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ imported: true, extension_id: manifest.id, version: "1.0.0", artifact_sha256: artifactSha256 });
    expect(await (await importRequest()).json()).toMatchObject({ imported: false, extension_id: manifest.id });
    const conflict = await importRequest({ artifactSha256: "d".repeat(64) });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error_code: "extension_package_release_immutable_conflict" });
    const release = await space.fetch(new Request(`http://space/extension-package-release?extension_id=${manifest.id}&version=1.0.0`));
    expect(await release.json()).toMatchObject({ release: { extension_id: manifest.id, version: "1.0.0", manifest_json: manifestJson,
      artifact_sha256: artifactSha256,
      publisher: { id: "pub_example", key_id: "b".repeat(64), signature: "publisher-signature", payload_sha256: "c".repeat(64) } } });
    expect(storage.sql.exec("SELECT host_signature FROM extension_releases WHERE extension_id=? AND version=?", manifest.id, "1.0.0")
      .toArray()[0]?.host_signature).toMatch(/^[a-f0-9]{64}$/);
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
