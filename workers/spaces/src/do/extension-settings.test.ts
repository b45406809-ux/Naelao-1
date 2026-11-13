import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

describe("Space-shared extension settings", () => {
  it("validates and persists per-install settings with defaults and optimistic revisions", async () => {
    const storage = createDOStorage(), secret = "extension-settings-test-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ plan_tier: "free" }) }) }) }, PLATFORM_SECRET: secret } as never);
    const manifest = {
      id: "ext_voice_dashboard", type: "extension", declaredPermissions: ["extension.settings.read", "extension.settings.configure", "assistant.voice.read", "assistant.voice.configure"],
      capabilityRequirements: ["extension.settings.read", "extension.settings.configure", "assistant.voice.read", "assistant.voice.configure"],
      gadgets: [{ id: "voice_dashboard", name: "Voice Dashboard", viewportComponent: "./voice.ts", scope: "SPACE_SHARED", gadgetTier: 3, defaultSchemaSql: "" }],
      daemons: [], commands: [], settingsSchema: { schemaVersion: 2, fields: [
        { id: "language", type: "select", label: "Language", options: [{ value: "en", label: "English" }, { value: "fr", label: "French" }], defaultValue: "en" },
        { id: "enabled", type: "boolean", label: "Enabled", defaultValue: false },
        { id: "greeting", type: "text", label: "Greeting", required: true, minLength: 2, maxLength: 80,
          visibleWhen: { fieldId: "enabled", equals: true }, localization: { label: { en: "Greeting", fr: "Salutation" } } },
      ] },
    } as const;
    const install = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED", gatekeeperCapabilities: [...manifest.capabilityRequirements] }) }));
    expect(install.status).toBe(201);
    expect(await (await space.fetch(new Request("http://space/space-shared-extensions?tenant_id=tenant&space_id=space"))).json()).toMatchObject({
      apps: [expect.objectContaining({ app_id: "voice_dashboard", settings_schema: manifest.settingsSchema })],
    });
    const token = await mintInternalToken(secret, "tenant");
    const request = (method: "GET" | "PATCH", role = "admin", body?: unknown, appId = "voice_dashboard") => space.fetch(new Request(`http://space/extension-settings?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", app_id: appId })}`, {
      method, headers: { "x-naelao-internal-token": token, "x-naelao-role": role, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const initial = await request("GET");
    expect(initial.headers.get("cache-control")).toContain("no-store");
    expect(await initial.json()).toMatchObject({ revision: 0, settings: { language: "en", enabled: false }, schema: { schemaVersion: 2 } });
    expect((await request("PATCH", "member", { settings: { enabled: true, greeting: "Hello" }, revision: 0 })).status).toBe(403);
    expect((await request("PATCH", "admin", { settings: { enabled: true, greeting: "H" }, revision: 0 })).status).toBe(400);
    const saved = await request("PATCH", "admin", { settings: { enabled: true, greeting: "Hello" }, revision: 0 });
    expect(await saved.json()).toMatchObject({ revision: 1, settings: { language: "en", enabled: true, greeting: "Hello" } });
    expect((await request("PATCH", "admin", { settings: { enabled: true, greeting: "Changed" }, revision: 0 })).status).toBe(409);
    expect(await (await request("GET")).json()).toMatchObject({ revision: 1, settings: { language: "en", enabled: true, greeting: "Hello" } });
    expect((await request("GET", "admin", undefined, "wrong_app")).status).toBe(404);

    const voiceRequest = (method: "GET" | "PATCH", role = "admin", body?: unknown, appId = "voice_dashboard") => space.fetch(new Request(`http://space/extension-assistant-voice?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", app_id: appId })}`, {
      method, headers: { "x-naelao-internal-token": token, "x-naelao-role": role, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    expect(await (await voiceRequest("GET")).json()).toMatchObject({ revision: 0, preferences: { enabled: false }, voiceCatalog: expect.any(Array) });
    expect((await voiceRequest("PATCH", "member", { preferences: { language: "en" }, revision: 0 })).status).toBe(403);
    expect(await (await voiceRequest("PATCH", "admin", { preferences: { enabled: true, language: "en" }, revision: 0 })).json()).toMatchObject({ revision: 1, preferences: { enabled: true, language: "en" } });
    expect((await voiceRequest("GET", "admin", undefined, "wrong_app")).status).toBe(404);
  });

  it("reads and updates only the exact active project installation after project authority is supplied", async () => {
    const storage = createDOStorage(), secret = "project-extension-settings-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ plan_tier: "free" }) }) }) }, PLATFORM_SECRET: secret } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=owner&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','Project A','active'),('project-b','space','Project B','active')");
    const manifest = { id: "ext_project_voice", type: "extension", declaredPermissions: ["extension.settings.read", "extension.settings.configure"],
      capabilityRequirements: ["extension.settings.read", "extension.settings.configure"], gadgets: [], daemons: [], commands: [],
      settingsSchema: { schemaVersion: 1, fields: [{ id: "greeting", type: "text", label: "Greeting", required: true, minLength: 2, maxLength: 80 }] } };
    const installed = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "PROJECT_BOUND", projectId: "project-a", gatekeeperCapabilities: manifest.capabilityRequirements }) }));
    expect(installed.status).toBe(201);
    const { installationId } = await installed.json() as { installationId: string };
    const token = await mintInternalToken(secret, "tenant");
    const request = (method: "GET" | "PATCH", manage = false, projectId = "project-a", body?: unknown, read = true) => space.fetch(new Request(`http://space/extension-settings?${new URLSearchParams({
      tenant_id: "tenant", space_id: "space", project_id: projectId, instance_id: installationId,
    })}`, {
      method, headers: { "x-naelao-internal-token": token, ...(read ? { "x-naelao-project-read": "1" } : {}), ...(manage ? { "x-naelao-project-manage": "1" } : {}), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    expect((await request("GET", false, "project-a", undefined, false)).status).toBe(403);
    const readable = await request("GET");
    expect(await readable.json()).toMatchObject({ revision: 0, can_configure: false, settings: {} });
    expect((await request("PATCH", false, "project-a", { settings: { greeting: "Hello" }, revision: 0 })).status).toBe(403);
    expect((await request("GET", true, "project-b")).status).toBe(404);
    const saved = await request("PATCH", true, "project-a", { settings: { greeting: "Hello" }, revision: 0 });
    expect(await saved.json()).toMatchObject({ revision: 1, settings: { greeting: "Hello" } });
    expect(await (await request("GET", false)).json()).toMatchObject({ revision: 1, can_configure: false, settings: { greeting: "Hello" } });

    const userInstall = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: { ...manifest, id: "ext_project_user_voice" }, installedBy: "user-a", tenantId: "tenant", spaceId: "space",
        scope: "PROJECT_USER", projectId: "project-a", userId: "user-a", gatekeeperCapabilities: manifest.capabilityRequirements }) }));
    expect(userInstall.status).toBe(201);
    const { installationId: userInstallationId } = await userInstall.json() as { installationId: string };
    const userRequest = (method: "GET" | "PATCH", userId: string, body?: unknown) => space.fetch(new Request(`http://space/extension-settings?${new URLSearchParams({
      tenant_id: "tenant", space_id: "space", project_id: "project-a", instance_id: userInstallationId,
    })}`, { method, headers: { "x-naelao-internal-token": token, "x-naelao-project-read": "1", "x-naelao-user-id": userId,
      "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    expect(await (await userRequest("GET", "user-a")).json()).toMatchObject({ revision: 0, can_configure: true });
    expect((await userRequest("PATCH", "user-a", { settings: { greeting: "Mine" }, revision: 0 })).status).toBe(200);
    expect((await userRequest("GET", "user-b")).status).toBe(404);

    const removed = await space.fetch(new Request(`http://space/extension-installation?${new URLSearchParams({
      instance_id: installationId, tenant_id: "tenant", space_id: "space", project_id: "project-a",
    })}`, { method: "DELETE" }));
    expect(removed.status).toBe(200);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM extension_installation_settings WHERE instance_id=?", installationId).toArray()[0]?.count).toBe(0);
    expect((await request("GET")).status).toBe(404);
  });
});
