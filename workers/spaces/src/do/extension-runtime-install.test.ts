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
});
