import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

describe("Space-shared extension settings", () => {
  it("validates and persists per-install settings with defaults and optimistic revisions", async () => {
    const storage = createDOStorage(), secret = "extension-settings-test-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ plan_tier: "free" }) }) }) }, PLATFORM_SECRET: secret } as never);
    const manifest = {
      id: "ext_voice_dashboard", type: "extension", declaredPermissions: ["extension.settings.read", "extension.settings.configure"],
      capabilityRequirements: ["extension.settings.read", "extension.settings.configure"],
      gadgets: [{ id: "voice_dashboard", name: "Voice Dashboard", viewportComponent: "./voice.ts", scope: "SPACE_SHARED", gadgetTier: 3, defaultSchemaSql: "" }],
      daemons: [], commands: [], settingsSchema: { schemaVersion: 1, fields: [
        { id: "language", type: "select", label: "Language", options: [{ value: "en", label: "English" }, { value: "fr", label: "French" }], defaultValue: "en" },
        { id: "greeting", type: "text", label: "Greeting", required: true, minLength: 2, maxLength: 80 },
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
    expect(await initial.json()).toMatchObject({ revision: 0, settings: { language: "en" }, schema: { schemaVersion: 1 } });
    expect((await request("PATCH", "member", { settings: { greeting: "Hello" }, revision: 0 })).status).toBe(403);
    expect((await request("PATCH", "admin", { settings: { greeting: "H" }, revision: 0 })).status).toBe(400);
    const saved = await request("PATCH", "admin", { settings: { greeting: "Hello" }, revision: 0 });
    expect(await saved.json()).toMatchObject({ revision: 1, settings: { language: "en", greeting: "Hello" } });
    expect((await request("PATCH", "admin", { settings: { greeting: "Changed" }, revision: 0 })).status).toBe(409);
    expect(await (await request("GET")).json()).toMatchObject({ revision: 1, settings: { language: "en", greeting: "Hello" } });
    expect((await request("GET", "admin", undefined, "wrong_app")).status).toBe(404);
  });
});
