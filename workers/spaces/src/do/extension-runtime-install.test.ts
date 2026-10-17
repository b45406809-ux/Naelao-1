import { describe, expect, it } from "vitest";
import { SpaceDO } from "./SpaceDO.js";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";

const image = "registry.example/media@sha256:" + "a".repeat(64);
function manifest(binary = "ffmpeg") {
  return { id: "ext_runtime_ffmpeg", type: "extension", declaredPermissions: ["container:execute"], capabilityRequirements: ["native-execution"],
    gadgets: [], daemons: [], commands: [], containers: [{ schemaVersion: "1.0", kind: "container", id: "ffmpeg", version: "1.0.0",
      permissions: [{ scope: "PROJECT_BOUND", actions: ["execute"], resource: "workspace" }], capabilityRequirements: ["native-execution"], lifecycle: {},
      image, resources: { memoryMb: 4096, cpuCores: 0.5, timeoutSeconds: 60 }, exportedBinaries: [binary], networkPolicy: "none" }] };
}

describe("runtime extension installation", () => {
  it("host-signs immutable bundle releases and only rolls back to a verified recorded version", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, { PLATFORM_SECRET: "release-test-secret" } as never);
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
    const rollback = await space.fetch(new Request("http://space/extension-releases/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ extensionId: "ext_versioned", version: "1.0.0" }) }));
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({ rolledBack: true, manifest: { bundle: { version: "1.0.0" } } });
  });

  it("installs a project-bound code indexer only for the selected project and preserves scope through restart", async () => {
    const storage = createDOStorage(), state = { storage };
    let space = new SpaceDO(state as never, {} as never);
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
    space = new SpaceDO(state as never, {} as never);
    expect(await (await list("project-b")).json()).toMatchObject({ installations: [] });
  });

  it("stores a composed versioned bundle and exposes its validated channel primitive to the runtime", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, { PLATFORM_SECRET: "test-platform-secret" } as never);
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
    const space = new SpaceDO(state as never, {} as never);
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

  it("validates scope before mutation, keeps manifests immutable, and replays installs after restart", async () => {
    const storage = createDOStorage();
    const state = { storage };
    let space = new SpaceDO(state as never, {} as never);
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

    space = new SpaceDO(state as never, {} as never);
    const list = await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project"));
    expect(await list.json()).toMatchObject({ installations: [{ instance: { instance_id: installed.installationId, scope: "SPACE_SHARED" } }] });
  });

  it("preserves existing unscoped extension revision updates when no scoped grant exists", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, {} as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=user&project_id=project"));
    const install = (value: unknown) => space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: value, installedBy: "owner", gatekeeperCapabilities: ["native-execution"] }) }));
    expect((await install(manifest())).status).toBe(201);
    expect((await install(manifest("ffprobe"))).status).toBe(201);
    expect(storage.sql.exec("SELECT manifest_json FROM installed_extensions WHERE extension_id='ext_runtime_ffmpeg'").toArray()[0]?.manifest_json).toContain("ffprobe");
  });

  it("promotes project installations atomically to a Space extension installation", async () => {
    const storage = createDOStorage(), state = { storage };
    const space = new SpaceDO(state as never, {} as never);
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
    const space = new SpaceDO(state as never, {} as never);
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
