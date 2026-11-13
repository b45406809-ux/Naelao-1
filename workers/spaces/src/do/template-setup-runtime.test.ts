import { PERSONAL_ASSISTANT_SPACE_TEMPLATE } from "@naelao/agent-sdk";
import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

describe("Space Template setup runtime API", () => {
  it("limits setup values to the exact active required extension and enforces revisions", async () => {
    const storage = createDOStorage(), secret = "template-setup-test-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret } as never);
    const targetSpaceId = "template-runtime-space";
    const manifest = {
      id: "ext_support_setup", type: "extension", declaredPermissions: ["template.setup.read", "template.setup.configure"],
      capabilityRequirements: ["template.setup.read", "template.setup.configure"],
      gadgets: [{ id: "support_setup", name: "Support setup", viewportComponent: "./setup.ts", scope: "SPACE_SHARED", gadgetTier: 3, defaultSchemaSql: "" }],
      daemons: [], commands: [],
    } as const;
    const installed = await space.fetch(new Request("http://space/extensions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest, installedBy: "owner", tenantId: "tenant", spaceId: targetSpaceId, scope: "SPACE_SHARED", gatekeeperCapabilities: [...manifest.capabilityRequirements] }) }));
    expect(installed.status).toBe(201);

    const blueprint = structuredClone(PERSONAL_ASSISTANT_SPACE_TEMPLATE);
    blueprint.setupSchemaVersion = 1;
    blueprint.requiredExtensions = [manifest.id];
    const project = blueprint.projects[0]!;
    project.id = "support";
    project.setupFields = [{ id: "greeting", type: "text", label: "Greeting", required: true, minLength: 2, maxLength: 80 }];
    storage.sql.exec(`INSERT INTO space_template_setup_drafts(tenant_id,space_id,blueprint_id,listing_id,artifact_sha256,
      setup_schema_version,setup_schema_sha256,setup_values_ciphertext,draft_revision,updated_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, "tenant", targetSpaceId, blueprint.id, "listing-a", "a".repeat(64), 1,
      "b".repeat(64), "encrypted-test-envelope", 1, "owner", "now", "now");
    const activated = await space.fetch(new Request("http://space/blueprints/instantiate", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" },
      body: JSON.stringify({ blueprint, target_space_id: targetSpaceId, activation_key: blueprint.id, listing_id: "listing-template", setup_values: { support: { greeting: "Welcome" } } }) }));
    expect(activated.status).toBe(201);
    expect(storage.sql.exec("SELECT blueprint_id FROM space_template_setup_drafts WHERE tenant_id=? AND space_id=?", "tenant", targetSpaceId).toArray()).toEqual([]);
    expect(storage.sql.exec("SELECT setup_schema_json,setup_revision FROM space_blueprint_installations WHERE space_id=? AND blueprint_id=?", targetSpaceId, blueprint.id).toArray()[0])
      .toMatchObject({ setup_schema_json: expect.stringContaining("support"), setup_revision: 1 });

    const token = await mintInternalToken(secret, "tenant");
    const statusUrl = `http://space/blueprint-installations?tenant_id=tenant&space_id=${encodeURIComponent(targetSpaceId)}`;
    expect((await space.fetch(new Request(statusUrl))).status).toBe(403);
    const status = await space.fetch(new Request(statusUrl, { headers: { "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token } }));
    expect(status.headers.get("cache-control")).toContain("no-store");
    const statusBody = await status.json() as { installations: Array<Record<string, unknown>> };
    expect(statusBody.installations).toMatchObject([{ blueprint_id: blueprint.id, listing_id: "listing-template", setup_schema_version: 1,
      setup_revision: 1, status: "installed", required_extension_ids: [manifest.id] }]);
    expect(statusBody.installations[0]).not.toHaveProperty("setup_values_json");
    expect(statusBody.installations[0]).not.toHaveProperty("setup_schema_json");
    const request = (method: "GET" | "PATCH", appId = "support_setup", role = "admin", body?: unknown, projectId = "support") => {
      const query = new URLSearchParams({ tenant_id: "tenant", space_id: targetSpaceId, app_id: appId, blueprint_id: blueprint.id, project_id: projectId });
      return space.fetch(new Request(`http://space/extension-template-setup?${query}`, { method,
        headers: { "x-naelao-internal-token": token, "x-naelao-role": role, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    };

    const initial = await request("GET");
    expect(initial.headers.get("cache-control")).toContain("no-store");
    expect(await initial.json()).toMatchObject({ schema: { project_id: "support" }, values: { greeting: "Welcome" }, revision: 1 });
    expect((await request("GET", "other_app")).status).toBe(404);
    expect((await request("GET", "support_setup", "admin", undefined, "other_project")).status).toBe(404);
    expect((await request("PATCH", "support_setup", "member", { values: { greeting: "Changed" }, revision: 1 })).status).toBe(403);
    expect((await request("PATCH", "support_setup", "admin", { values: { greeting: "x" }, revision: 1 })).status).toBe(400);

    const saved = await request("PATCH", "support_setup", "admin", { values: { greeting: "Hello from runtime" }, revision: 1 });
    expect(await saved.json()).toMatchObject({ values: { greeting: "Hello from runtime" }, revision: 2 });
    expect((await request("PATCH", "support_setup", "admin", { values: { greeting: "Stale" }, revision: 1 })).status).toBe(409);
    expect(await (await request("GET")).json()).toMatchObject({ values: { greeting: "Hello from runtime" }, revision: 2 });

    storage.sql.exec("UPDATE space_blueprint_installations SET required_extensions_json='[]' WHERE space_id=? AND blueprint_id=?", targetSpaceId, blueprint.id);
    expect((await request("GET")).status).toBe(403);
  });
});
