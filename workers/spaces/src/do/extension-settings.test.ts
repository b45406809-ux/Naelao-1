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
    const { installationId: spaceInstallationId } = await install.json() as { installationId: string };
    expect(await (await space.fetch(new Request("http://space/space-shared-extensions?tenant_id=tenant&space_id=space"))).json()).toMatchObject({
      apps: [expect.objectContaining({ app_id: "voice_dashboard", runtime_primitive: "gadget", dependency_pins: [], settings_schema: manifest.settingsSchema })],
    });
    const token = await mintInternalToken(secret, "tenant");
    const request = (method: "GET" | "PATCH", role = "admin", body?: unknown, appId = "voice_dashboard", userId = "owner_a") => space.fetch(new Request(`http://space/extension-settings?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", app_id: appId })}`, {
      method, headers: { "x-naelao-internal-token": token, ...(userId ? { "x-naelao-user-id": userId } : {}), "x-naelao-role": role, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    expect((await request("PATCH", "admin", { settings: { enabled: false }, revision: 1 }, "voice_dashboard", "")).status).toBe(403);
    const audit = await space.fetch(new Request(`http://space/extension-settings-audit?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", instance_id: spaceInstallationId })}`,
      { headers: { "x-naelao-internal-token": token, "x-naelao-user-id": "owner_a", "x-naelao-role": "admin" } }));
    expect(audit.status).toBe(200);
    const auditBody = await audit.json() as { events: Array<Record<string, unknown>> };
    expect(auditBody.events).toHaveLength(1);
    expect(auditBody.events[0]).toMatchObject({ extension_id: manifest.id, scope: "SPACE_SHARED", actor_id: "owner_a", actor_role: "admin",
      prior_revision: 0, new_revision: 1, schema_version: 2, changed_field_ids: ["enabled", "greeting"] });
    expect(JSON.stringify(auditBody)).not.toContain("Hello");
    const deniedAudit = await space.fetch(new Request(`http://space/extension-settings-audit?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", instance_id: spaceInstallationId })}`,
      { headers: { "x-naelao-internal-token": token, "x-naelao-user-id": "member_a", "x-naelao-role": "member" } }));
    expect(deniedAudit.status).toBe(403);

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
      method, headers: { "x-naelao-internal-token": token, "x-naelao-user-id": "manager_a", "x-naelao-role": "editor", ...(read ? { "x-naelao-project-read": "1" } : {}), ...(manage ? { "x-naelao-project-manage": "1" } : {}), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    expect((await request("GET", false, "project-a", undefined, false)).status).toBe(403);
    const readable = await request("GET");
    expect(await readable.json()).toMatchObject({ revision: 0, can_configure: false, settings: {} });
    expect((await request("PATCH", false, "project-a", { settings: { greeting: "Hello" }, revision: 0 })).status).toBe(403);
    expect((await request("GET", true, "project-b")).status).toBe(404);
    const saved = await request("PATCH", true, "project-a", { settings: { greeting: "Hello" }, revision: 0 });
    expect(await saved.json()).toMatchObject({ revision: 1, settings: { greeting: "Hello" } });
    const managerOnlyAudit = await space.fetch(new Request(`http://space/extension-settings-audit?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", project_id: "project-a", instance_id: installationId })}`,
      { headers: { "x-naelao-internal-token": token, "x-naelao-user-id": "reader_a", "x-naelao-role": "member", "x-naelao-project-read": "1" } }));
    expect(managerOnlyAudit.status).toBe(403);
    expect(await (await request("GET", false)).json()).toMatchObject({ revision: 1, can_configure: false, settings: { greeting: "Hello" } });

    storage.sql.exec("UPDATE extension_installation_settings SET settings_json=? WHERE instance_id=?",
      JSON.stringify({ greeting: "Hello", retired_field: "legacy" }), installationId);
    const nextManifest = { ...manifest, settingsSchema: { schemaVersion: 2, fields: [
      { id: "greeting", type: "text" as const, label: "Greeting", required: true, minLength: 2, maxLength: 80 },
      { id: "language", type: "select" as const, label: "Language", defaultValue: "en", options: [{ value: "en", label: "English" }, { value: "fr", label: "French" }] },
    ] } };
    storage.sql.exec("UPDATE installed_extensions SET manifest_json=? WHERE extension_id=?", JSON.stringify(nextManifest), manifest.id);
    const migrationPreview = await request("GET", true);
    const previewBody = await migrationPreview.json() as { settings: Record<string, unknown> };
    expect(previewBody).toMatchObject({ migration_required: true, revision: 1, schema: { schemaVersion: 2 }, settings: { greeting: "Hello", language: "en" } });
    expect(previewBody.settings).not.toHaveProperty("retired_field");
    const migrated = await request("PATCH", true, "project-a", { settings: { greeting: "Hello", language: "fr" }, revision: 1 });
    expect(await migrated.json()).toMatchObject({ migration_required: false, revision: 2, settings: { greeting: "Hello", language: "fr" } });
    expect(await (await request("GET", true)).json()).toMatchObject({ migration_required: false, revision: 2, schema: { schemaVersion: 2 } });

    const userInstall = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: { ...manifest, id: "ext_project_user_voice" }, installedBy: "user-a", tenantId: "tenant", spaceId: "space",
        scope: "PROJECT_USER", projectId: "project-a", userId: "user-a", gatekeeperCapabilities: manifest.capabilityRequirements }) }));
    expect(userInstall.status).toBe(201);
    const { installationId: userInstallationId } = await userInstall.json() as { installationId: string };
    const userRequest = (method: "GET" | "PATCH", userId: string, body?: unknown) => space.fetch(new Request(`http://space/extension-settings?${new URLSearchParams({
      tenant_id: "tenant", space_id: "space", project_id: "project-a", instance_id: userInstallationId,
    })}`, { method, headers: { "x-naelao-internal-token": token, "x-naelao-project-read": "1", "x-naelao-user-id": userId, "x-naelao-role": "member",
      "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    expect(await (await userRequest("GET", "user-a")).json()).toMatchObject({ revision: 0, can_configure: true });
    expect((await userRequest("PATCH", "user-a", { settings: { greeting: "Mine" }, revision: 0 })).status).toBe(200);
    expect((await userRequest("GET", "user-b")).status).toBe(404);
    const ownAudit = await space.fetch(new Request(`http://space/extension-settings-audit?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", project_id: "project-a", instance_id: userInstallationId })}`,
      { headers: { "x-naelao-internal-token": token, "x-naelao-user-id": "user-a", "x-naelao-role": "member", "x-naelao-project-read": "1" } }));
    expect(await ownAudit.json()).toMatchObject({ events: [expect.objectContaining({ actor_id: "user-a", scope: "PROJECT_USER", changed_field_ids: ["greeting"] })] });
    const otherAudit = await space.fetch(new Request(`http://space/extension-settings-audit?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", project_id: "project-a", instance_id: userInstallationId })}`,
      { headers: { "x-naelao-internal-token": token, "x-naelao-user-id": "user-b", "x-naelao-role": "member", "x-naelao-project-read": "1" } }));
    expect(otherAudit.status).toBe(403);

    let releaseBody!: () => void;
    let markBodyRead!: () => void;
    const bodyRead = new Promise<void>(resolve => { markBodyRead = resolve; });
    const bodyStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        markBodyRead();
        return new Promise<void>(resolve => {
          releaseBody = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ settings: { greeting: "Late write", language: "fr" }, revision: 2 }))); controller.close(); resolve(); };
        });
      },
    });
    const pendingWrite = space.fetch(new Request(`http://space/extension-settings?${new URLSearchParams({
      tenant_id: "tenant", space_id: "space", project_id: "project-a", instance_id: installationId,
    })}`, { method: "PATCH", headers: { "x-naelao-internal-token": token, "x-naelao-project-read": "1", "x-naelao-project-manage": "1", "x-naelao-user-id": "manager_a", "x-naelao-role": "editor", "content-type": "application/json" },
      body: bodyStream, duplex: "half" } as RequestInit));
    await bodyRead;
    const removed = await space.fetch(new Request(`http://space/extension-installation?${new URLSearchParams({
      instance_id: installationId, tenant_id: "tenant", space_id: "space", project_id: "project-a",
    })}`, { method: "DELETE" }));
    expect(removed.status).toBe(200);
    releaseBody();
    expect((await pendingWrite).status).toBe(404);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM extension_installation_settings WHERE instance_id=?", installationId).toArray()[0]?.count).toBe(0);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM extension_settings_audit_events WHERE instance_id=?", installationId).toArray()[0]?.count).toBe(2);
    const audit = await space.fetch(new Request(`http://space/extension-settings-audit?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", project_id: "project-a", instance_id: installationId })}`,
      { headers: { "x-naelao-internal-token": token, "x-naelao-project-read": "1", "x-naelao-project-manage": "1", "x-naelao-user-id": "manager_a", "x-naelao-role": "editor" } }));
    expect(await audit.json()).toMatchObject({ events: [expect.objectContaining({ prior_revision: 1, new_revision: 2, actor_id: "manager_a", scope: "PROJECT_BOUND" }),
      expect.objectContaining({ prior_revision: 0, new_revision: 1, actor_id: "manager_a", scope: "PROJECT_BOUND" })] });
    expect((await request("GET")).status).toBe(404);
  });

  it("serves only complete, validated settings to the exact active signed phone installation", async () => {
    const storage = createDOStorage(), secret = "phone-extension-settings-runtime-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ plan_tier: "free" }) }) }) }, PLATFORM_SECRET: secret } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=owner&project_id="));
    const manifest = {
      id: "ext_customer_phone", type: "extension", declaredPermissions: ["extension.settings.read", "extension.settings.configure"],
      capabilityRequirements: ["extension.settings.read", "extension.settings.configure"],
      settingsActivation: "owner_publish",
      gadgets: [{ id: "customer_phone", name: "Customer Phone", viewportComponent: "./phone.ts", scope: "SPACE_SHARED", gadgetTier: 3, defaultSchemaSql: "" }],
      daemons: [], commands: [], settingsSchema: { schemaVersion: 1, fields: [
        { id: "enabled", type: "boolean", label: "Enabled", defaultValue: true },
        { id: "greeting", type: "text", label: "Greeting", required: true, minLength: 2, maxLength: 80 },
      ] },
      bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_customer_phone", version: "1.0.0", primitives: [
        { schemaVersion: "1.0", kind: "channel", id: "phone", version: "1.0.0", provider: "phone", handlerScript: "./phone.ts", context: "channel_only",
          inboundEvents: ["message.received", "call.received"], outboundEvents: ["message.reply", "voice.reply"], permissions: [], capabilityRequirements: [], lifecycle: {} },
      ] },
    } as const;
    const installed = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "SPACE_SHARED",
        gatekeeperCapabilities: [...manifest.capabilityRequirements], artifactSha256: "a".repeat(64) }) }));
    expect(installed.status, await installed.clone().text()).toBe(201);
    const { installationId, release } = await installed.json() as { installationId: string; release: { version: string; artifactSha256: string } };
    const token = await mintInternalToken(secret, "tenant");
    const readRuntimeSettings = (overrides: { tenant?: string; space?: string; instance?: string; token?: string; expectedVersion?: string; settingsSource?: "active" | "draft"; settingsRevision?: number } = {}) => {
      const query = new URLSearchParams({ tenant_id: overrides.tenant ?? "tenant", space_id: overrides.space ?? "space", instance_id: overrides.instance ?? installationId,
        expected_version: overrides.expectedVersion ?? release.version, expected_artifact_sha256: release.artifactSha256,
        ...(overrides.settingsSource ? { settings_source: overrides.settingsSource } : {}),
        ...(overrides.settingsRevision !== undefined ? { settings_revision: String(overrides.settingsRevision) } : {}) });
      return space.fetch(new Request(`http://space/phone-extension-settings?${query}`, {
        headers: { "x-naelao-internal-token": overrides.token ?? token },
      }));
    };
    expect((await readRuntimeSettings({ token: "invalid" })).status).toBe(403);
    expect((await readRuntimeSettings({ tenant: "other-tenant" })).status).toBe(403);
    expect((await readRuntimeSettings({ instance: "another-installation" })).status).toBe(404);
    expect((await readRuntimeSettings({ expectedVersion: "2.0.0" })).status).toBe(409);
    expect(await (await readRuntimeSettings()).json()).toMatchObject({ error_code: "phone_extension_settings_invalid" });

    const ownerSettings = (body: unknown) => space.fetch(new Request(`http://space/extension-settings?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", app_id: "customer_phone" })}`, {
      method: "PATCH", headers: { "x-naelao-internal-token": token, "x-naelao-user-id": "owner_a", "x-naelao-role": "owner", "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await ownerSettings({ settings: { enabled: true, greeting: "Welcome" }, revision: 0 })).status).toBe(400);
    const initial = await space.fetch(new Request(`http://space/extension-settings?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", app_id: "customer_phone" })}`, {
      headers: { "x-naelao-internal-token": token, "x-naelao-user-id": "owner_a", "x-naelao-role": "owner" },
    }));
    expect(await initial.json()).toMatchObject({ activation_policy: "owner_publish", revision: 0, draft: null, settings: { enabled: true } });
    const unauthorizedDraft = await space.fetch(new Request(`http://space/extension-settings?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", app_id: "customer_phone" })}`, {
      method: "PATCH", headers: { "x-naelao-internal-token": token, "x-naelao-user-id": "member_a", "x-naelao-role": "member", "content-type": "application/json" },
      body: JSON.stringify({ action: "save_draft", settings: { enabled: true, greeting: "Member" }, draft_revision: 0, base_active_revision: 0 }),
    }));
    expect(unauthorizedDraft.status).toBe(403);
    const memberRead = await space.fetch(new Request(`http://space/extension-settings?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", app_id: "customer_phone" })}`, {
      headers: { "x-naelao-internal-token": token, "x-naelao-user-id": "member_a", "x-naelao-role": "member" },
    }));
    const memberSettings = await memberRead.json() as Record<string, unknown>;
    expect(memberSettings).toMatchObject({ activation_policy: "owner_publish", settings: { enabled: true } });
    expect(memberSettings).not.toHaveProperty("published_versions");
    expect(memberSettings).not.toHaveProperty("draft");
    const savedDraft = await ownerSettings({ action: "save_draft", settings: { enabled: true, greeting: "Welcome" }, draft_revision: 0, base_active_revision: 0 });
    expect(await savedDraft.json()).toMatchObject({ active_revision: 0, draft: { revision: 1, status: "draft", settings: { enabled: true, greeting: "Welcome" } } });
    expect((await readRuntimeSettings()).status).toBe(409); // Live handler remains on the published row.
    expect(await (await readRuntimeSettings({ settingsSource: "draft" })).json()).toMatchObject({
      schema_version: 1, revision: 1, active_revision: 0, settings_source: "draft", settings: { enabled: true, greeting: "Welcome" },
    });
    expect((await ownerSettings({ action: "publish", draft_revision: 1, expected_active_revision: 1, confirm: true })).status).toBe(409);
    expect((await readRuntimeSettings()).status).toBe(409); // Conflicting publish did not alter active settings.
    expect((await ownerSettings({ action: "publish", draft_revision: 1, expected_active_revision: 0 })).status).toBe(400);
    const published = await ownerSettings({ action: "publish", draft_revision: 1, expected_active_revision: 0, confirm: true });
    expect(await published.json()).toMatchObject({ activation_policy: "owner_publish", published: true, replayed: false,
      revision: 1, settings: { enabled: true, greeting: "Welcome" } });
    const runtimeSettings = await readRuntimeSettings();
    expect(runtimeSettings.headers.get("cache-control")).toContain("no-store");
    expect(await runtimeSettings.json()).toEqual({ schema_version: 1, revision: 1, active_revision: 1, settings_source: "active",
      settings: { enabled: true, greeting: "Welcome" } });
    expect(await (await readRuntimeSettings({ settingsRevision: 1 })).json()).toEqual({ schema_version: 1, revision: 1, active_revision: 1,
      settings_source: "active", settings: { enabled: true, greeting: "Welcome" } });
    expect(await (await ownerSettings({ action: "publish", draft_revision: 1, expected_active_revision: 0, confirm: true })).json())
      .toMatchObject({ replayed: true, revision: 1 });
    const settingsAudit = await space.fetch(new Request(`http://space/extension-settings-audit?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", instance_id: installationId })}`,
      { headers: { "x-naelao-internal-token": token, "x-naelao-user-id": "owner_a", "x-naelao-role": "owner" } }));
    const auditBody = await settingsAudit.json() as { events: Array<Record<string, unknown>> };
    expect(auditBody.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "active", prior_revision: 0, new_revision: 1, changed_field_ids: ["greeting"] }),
      expect.objectContaining({ target: "draft", prior_revision: 0, new_revision: 1, changed_field_ids: ["greeting"] }),
    ]));
    expect(JSON.stringify(auditBody)).not.toContain("Welcome");

    expect(await (await ownerSettings({ action: "save_draft", settings: { enabled: true, greeting: "Changed" }, draft_revision: 1, base_active_revision: 1 })).json())
      .toMatchObject({ draft: { revision: 2, status: "draft" }, active_revision: 1 });
    expect(await (await ownerSettings({ action: "publish", draft_revision: 2, expected_active_revision: 1, confirm: true })).json())
      .toMatchObject({ published: true, revision: 2, settings: { greeting: "Changed" } });
    expect(await (await readRuntimeSettings({ settingsRevision: 1 })).json()).toMatchObject({ revision: 1, active_revision: 2,
      settings: { greeting: "Welcome" } });
    expect(await (await readRuntimeSettings({ settingsRevision: 2 })).json()).toMatchObject({ revision: 2, active_revision: 2,
      settings: { greeting: "Changed" } });
    const ownerRead = () => space.fetch(new Request(`http://space/extension-settings?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", app_id: "customer_phone" })}`, {
      headers: { "x-naelao-internal-token": token, "x-naelao-user-id": "owner_a", "x-naelao-role": "owner" },
    }));
    expect(await (await ownerRead()).json()).toMatchObject({ revision: 2, settings: { greeting: "Changed" }, published_versions: [
      { version: 2, schema_version: 1, published_by: "owner_a", source_draft_revision: 2 },
      { version: 1, schema_version: 1, published_by: "owner_a", source_draft_revision: 1 },
    ] });
    const rollbackDraft = await ownerSettings({ action: "rollback_draft", version: 1, draft_revision: 2, base_active_revision: 2 });
    expect(await rollbackDraft.json()).toMatchObject({ rollback_draft: true, source_version: 1,
      draft: { revision: 3, status: "draft", settings: { enabled: true, greeting: "Welcome" } } });
    expect(await (await readRuntimeSettings()).json()).toMatchObject({ revision: 2, settings: { enabled: true, greeting: "Changed" } });
    expect(await (await ownerSettings({ action: "publish", draft_revision: 3, expected_active_revision: 2, confirm: true })).json())
      .toMatchObject({ published: true, revision: 3, settings: { greeting: "Welcome" } });
    expect(await (await ownerRead()).json()).toMatchObject({ revision: 3, published_versions: [
      { version: 3, source_draft_revision: 3 }, { version: 2, source_draft_revision: 2 }, { version: 1, source_draft_revision: 1 },
    ] });
    storage.sql.exec("UPDATE extension_installation_settings_versions SET schema_version=2 WHERE instance_id=? AND version=1", installationId);
    const incompatibleRollback = await ownerSettings({ action: "rollback_draft", version: 1, draft_revision: 3, base_active_revision: 3 });
    expect(incompatibleRollback.status).toBe(409);
    expect(await incompatibleRollback.json()).toMatchObject({ error_code: "extension_settings_version_incompatible" });
    expect(await (await readRuntimeSettings()).json()).toMatchObject({ revision: 3, settings: { greeting: "Welcome" } });

    storage.sql.exec("UPDATE extension_installation_settings SET settings_json=? WHERE instance_id=?", JSON.stringify({ greeting: "Welcome", unrelated: "private" }), installationId);
    expect((await readRuntimeSettings()).status).toBe(409);
    expect((await readRuntimeSettings({ settingsRevision: 99 })).status).toBe(409);
    storage.sql.exec("UPDATE extension_releases SET host_signature=? WHERE extension_id=? AND version=?", "0".repeat(64), manifest.id, manifest.bundle.version);
    expect((await readRuntimeSettings()).status).toBe(409);
    storage.sql.exec("UPDATE extension_instances SET status='disabled' WHERE instance_id=?", installationId);
    expect((await readRuntimeSettings()).status).toBe(404);
    const removed = await space.fetch(new Request(`http://space/extension-installation?${new URLSearchParams({
      instance_id: installationId, tenant_id: "tenant", space_id: "space",
    })}`, { method: "DELETE" }));
    expect(removed.status).toBe(200);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM extension_installation_settings_drafts WHERE instance_id=?", installationId).toArray()[0]?.count).toBe(0);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM extension_installation_settings_versions WHERE instance_id=?", installationId).toArray()[0]?.count).toBe(0);
  });
});

describe("delegated project extension settings proposals", () => {
  it("requires project-owner authority to read or publish owner-approved drafts", async () => {
    const storage = createDOStorage(), secret = "project-owner-publish-settings-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=owner&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project-a','space','Project A','active')");
    const manifest = { id: "ext_owner_config", type: "extension", bundle: { schemaVersion: "1.0", kind: "extension_bundle" as const,
      id: "ext_owner_config", version: "1.0.0", primitives: [] }, settingsActivation: "owner_publish",
      declaredPermissions: ["extension.settings.read", "extension.settings.configure"], capabilityRequirements: ["extension.settings.read", "extension.settings.configure"],
      gadgets: [], daemons: [], commands: [], settingsSchema: { schemaVersion: 1, fields: [{ id: "greeting", type: "text" as const, label: "Greeting", required: true, minLength: 2, maxLength: 80 }] } };
    const installed = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "PROJECT_BOUND", projectId: "project-a",
        gatekeeperCapabilities: manifest.capabilityRequirements }) }));
    expect(installed.status, await installed.clone().text()).toBe(201);
    const { installationId } = await installed.json() as { installationId: string };
    const token = await mintInternalToken(secret, "tenant");
    const url = `http://space/extension-settings?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", project_id: "project-a", instance_id: installationId })}`;
    const editorHeaders = { "x-naelao-internal-token": token, "x-naelao-user-id": "editor-a", "x-naelao-role": "editor",
      "x-naelao-project-read": "1", "x-naelao-project-manage": "1", "content-type": "application/json" };
    const ownerHeaders = { ...editorHeaders, "x-naelao-user-id": "project-owner", "x-naelao-project-owner": "1" };
    const editorRead = await space.fetch(new Request(url, { headers: editorHeaders }));
    expect(await editorRead.json()).toMatchObject({ activation_policy: "owner_publish", can_configure: false, revision: 0, settings: {} });
    const rejectedDraft = await space.fetch(new Request(url, { method: "PATCH", headers: editorHeaders,
      body: JSON.stringify({ action: "save_draft", settings: { greeting: "Editor" }, draft_revision: 0, base_active_revision: 0 }) }));
    expect(rejectedDraft.status).toBe(403);

    const saved = await space.fetch(new Request(url, { method: "PATCH", headers: ownerHeaders,
      body: JSON.stringify({ action: "save_draft", settings: { greeting: "Owner" }, draft_revision: 0, base_active_revision: 0 }) }));
    expect(await saved.json()).toMatchObject({ active_revision: 0, draft: { revision: 1, status: "draft", settings: { greeting: "Owner" } } });
    const published = await space.fetch(new Request(url, { method: "PATCH", headers: ownerHeaders,
      body: JSON.stringify({ action: "publish", draft_revision: 1, expected_active_revision: 0, confirm: true }) }));
    expect(await published.json()).toMatchObject({ published: true, revision: 1, settings: { greeting: "Owner" } });
  });

  it("lets an explicitly granted project agent create a revision-fenced draft without publishing or returning settings values", async () => {
    const storage = createDOStorage(), secret = "extension-agent-settings-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret } as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=space&user_id=owner&project_id=project-a"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status,allowed_agent_ids) VALUES('project-a','space','Project A','active',?)", JSON.stringify(["agent-a"]));
    storage.sql.exec("INSERT INTO agent_definitions(id,space_id,name,enabled) VALUES('agent-a','space','Project Agent',1),('agent-b','space','Other Agent',1)");
    const manifest = { id: "ext_project_config", type: "extension", settingsActivation: "owner_publish",
      declaredPermissions: ["extension.settings.read", "extension.settings.configure"],
      capabilityRequirements: ["extension.settings.read", "extension.settings.configure"], gadgets: [], daemons: [], commands: [],
      settingsSchema: { schemaVersion: 1, fields: [
        { id: "language", type: "select" as const, label: "Language", defaultValue: "en", options: [{ value: "en", label: "English" }, { value: "fr", label: "French" }] },
        { id: "greeting", type: "text" as const, label: "Greeting", required: true, minLength: 2, maxLength: 80 },
      ] } };
    const installed = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest, installedBy: "owner", tenantId: "tenant", spaceId: "space", scope: "PROJECT_BOUND", projectId: "project-a",
        gatekeeperCapabilities: manifest.capabilityRequirements }) }));
    expect(installed.status, await installed.clone().text()).toBe(201);
    const { installationId } = await installed.json() as { installationId: string };
    const token = await mintInternalToken(secret, "tenant");
    const query = new URLSearchParams({ tenant_id: "tenant", space_id: "space", project_id: "project-a", instance_id: installationId });
    const ownerHeaders = { "x-naelao-internal-token": token, "x-naelao-user-id": "owner", "x-naelao-role": "owner", "x-naelao-project-read": "1", "x-naelao-project-manage": "1", "content-type": "application/json" };
    const agentHeaders = { "x-naelao-internal-token": token, "x-naelao-user-id": "member", "x-naelao-role": "member", "x-naelao-agent-id": "agent-a", "x-naelao-project-read": "1", "content-type": "application/json" };
    const grantPath = `http://space/extension-agent-maintenance-grants?${query}`;
    storage.sql.exec("UPDATE projects SET allowed_agent_ids=? WHERE id='project-a'", JSON.stringify("agent-a"));
    expect((await space.fetch(new Request(grantPath, { headers: ownerHeaders }))).status).toBe(409);
    storage.sql.exec("UPDATE projects SET allowed_agent_ids=? WHERE id='project-a'", JSON.stringify(["agent-a"]));
    const before = await space.fetch(new Request(grantPath, { headers: ownerHeaders }));
    expect(await before.json()).toMatchObject({ permission: "settings.propose", eligible_agents: [{ id: "agent-a", name: "Project Agent" }], grants: [] });
    expect((await space.fetch(new Request(grantPath, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ agent_id: "agent-b", permission: "settings.propose", expected_revision: 0 }) }))).status).toBe(400);
    const granted = await space.fetch(new Request(grantPath, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ agent_id: "agent-a", permission: "settings.propose", expected_revision: 0 }) }));
    expect(await granted.json()).toMatchObject({ agent_id: "agent-a", permission: "settings.propose", revision: 1, status: "active" });
    const proposalPath = `http://space/extension-settings-agent-proposal?${query}`;
    const status = await space.fetch(new Request(proposalPath, { headers: agentHeaders }));
    expect(await status.json()).toEqual({ active_revision: 0, draft_revision: 0, draft_status: "empty", approval_required: true });
    const proposed = await space.fetch(new Request(proposalPath, { method: "POST", headers: agentHeaders,
      body: JSON.stringify({ expected_active_revision: 0, expected_draft_revision: 0, changes: { greeting: "Hello" } }) }));
    expect(proposed.status).toBe(201);
    const proposedBody = await proposed.json();
    expect(proposedBody).toMatchObject({ proposal: { status: "draft", approval_required: true, active_revision: 0, draft_revision: 1, changed_field_ids: ["greeting"] } });
    expect(JSON.stringify(proposedBody)).not.toContain("Hello");
    const active = await storage.sql.exec<{ revision: number }>("SELECT revision FROM extension_installation_settings WHERE instance_id=?", installationId).toArray();
    expect(active).toHaveLength(0);
    expect(storage.sql.exec("SELECT revision,status FROM extension_installation_settings_drafts WHERE instance_id=?", installationId).toArray())
      .toEqual([{ revision: 1, status: "draft" }]);
    const stale = await space.fetch(new Request(proposalPath, { method: "POST", headers: agentHeaders,
      body: JSON.stringify({ expected_active_revision: 0, expected_draft_revision: 0, changes: { greeting: "Overwrite" } }) }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error_code: "extension_settings_revision_conflict" });
    const audit = await space.fetch(new Request(`http://space/extension-settings-audit?${query}`, { headers: ownerHeaders }));
    const auditBody = await audit.json();
    expect(auditBody).toMatchObject({ events: [expect.objectContaining({ actor_id: "agent-a", actor_role: "agent", actor_agent_id: "agent-a", delegated_by: "member", target: "draft", changed_field_ids: ["greeting"] })] });
    expect(JSON.stringify(auditBody)).not.toContain("Hello");
    const revoked = await space.fetch(new Request(grantPath, { method: "DELETE", headers: ownerHeaders,
      body: JSON.stringify({ agent_id: "agent-a", permission: "settings.propose", expected_revision: 1 }) }));
    expect(await revoked.json()).toMatchObject({ agent_id: "agent-a", revision: 2, status: "revoked" });
    expect((await space.fetch(new Request(proposalPath, { headers: agentHeaders }))).status).toBe(403);
  });
});
