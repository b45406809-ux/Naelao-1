import { PERSONAL_ASSISTANT_SPACE_TEMPLATE, validateBlueprintSetupSchema } from "@naelao/agent-sdk";
import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

describe("Space Template setup runtime API", () => {
  it("detaches and reattaches only the setup link with scoped confirmation and durable actor history", async () => {
    const storage = createDOStorage(), secret = "template-lifecycle-test-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret } as never);
    const spaceId = "template-lifecycle-space", blueprint = {
      id: "tpl_lifecycle", schemaVersion: "2.0" as const, metadata: { name: "Support setup" }, templateCategory: "support",
      projects: [{ id: "support", name: "Support", kind: "DualPane" as const, templateMode: "cowork_studio" as const,
        viewports: {}, systemPrompt: "", initialTasks: [], starterFiles: [] }],
      requiredExtensions: ["ext_support"], requiredCredentials: [],
    };
    const activated = await space.fetch(new Request("http://space/blueprints/instantiate", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" },
      body: JSON.stringify({ blueprint, target_space_id: spaceId, activation_key: blueprint.id }) }));
    expect(activated.status).toBe(201);
    const activation = await activated.json() as { projectIds: string[] };
    storage.sql.exec(`INSERT INTO space_template_setup_drafts
      (tenant_id,space_id,blueprint_id,listing_id,artifact_sha256,setup_schema_sha256,setup_values_ciphertext,draft_revision,updated_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, "tenant", spaceId, blueprint.id, "listing-lifecycle", "a".repeat(64), "b".repeat(64), "ciphertext",
    1, "owner-a", "2026-11-14T00:00:00.000Z", "2026-11-14T00:00:00.000Z");
    const token = await mintInternalToken(secret, "tenant");
    const url = (operation: "preview" | "apply") => `http://space/blueprint-installation-lifecycle/${operation}?${new URLSearchParams({ tenant_id: "tenant", space_id: spaceId, blueprint_id: blueprint.id })}`;
    const request = (path: string, body: unknown, role = "owner", withToken = true) => space.fetch(new Request(path, { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "owner-a", "x-naelao-role": role,
        ...(withToken ? { "x-naelao-internal-token": token } : {}) }, body: JSON.stringify(body) }));
    expect((await request(url("preview"), { operation: "detach" }, "owner", false)).status).toBe(403);
    expect((await request(url("preview"), { operation: "detach" }, "member")).status).toBe(403);
    const previewResponse = await request(url("preview"), { operation: "detach" });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { artifact_sha256: string; setup_revision: number; lifecycle_state: string;
      generated_project_ids: string[]; required_extension_ids: string[]; effects: Record<string, string> };
    expect(preview).toMatchObject({ lifecycle_state: "active", generated_project_ids: activation.projectIds,
      required_extension_ids: ["ext_support"], effects: { template_setup_association: "detached", generated_projects: "preserved",
        saved_setup_values: "retained", required_extensions: "preserved", project_knowledge_grants: "preserved", licenses_and_recurring_charges: "unchanged" } });
    const body = { operation: "detach", expected_artifact_sha256: preview.artifact_sha256, expected_setup_revision: preview.setup_revision,
      expected_lifecycle_state: "active", confirmed: true };
    expect((await request(url("apply"), { ...body, confirmed: false })).status).toBe(400);
    expect((await request(url("apply"), { ...body, expected_setup_revision: preview.setup_revision + 1 })).status).toBe(409);
    expect((await request(url("apply"), body)).status).toBe(200);
    expect(storage.sql.exec("SELECT lifecycle_state,detached_by,detached_at FROM space_blueprint_installations WHERE space_id=? AND blueprint_id=?", spaceId, blueprint.id).toArray()[0])
      .toMatchObject({ lifecycle_state: "detached", detached_by: "owner-a" });
    expect(storage.sql.exec("SELECT id FROM projects WHERE space_id=?", spaceId).toArray()).toHaveLength(1);
    expect(storage.sql.exec("SELECT blueprint_id FROM space_template_setup_drafts WHERE tenant_id=? AND space_id=?", "tenant", spaceId).toArray()).toHaveLength(0);
    expect(storage.sql.exec("SELECT action,actor_id FROM space_blueprint_lifecycle_events WHERE space_id=? AND blueprint_id=?", spaceId, blueprint.id).toArray())
      .toEqual([{ action: "detached", actor_id: "owner-a" }]);
    const activationRetry = await space.fetch(new Request("http://space/blueprints/instantiate", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" },
      body: JSON.stringify({ blueprint, target_space_id: spaceId, activation_key: blueprint.id }) }));
    expect(activationRetry.status).toBe(409);
    expect(await activationRetry.json()).toMatchObject({ error_code: "blueprint_installation_detached" });

    const reattachPreview = await (await request(url("preview"), { operation: "reattach" })).json() as typeof preview;
    const reattached = await request(url("apply"), { operation: "reattach", expected_artifact_sha256: reattachPreview.artifact_sha256,
      expected_setup_revision: reattachPreview.setup_revision, expected_lifecycle_state: "detached", confirmed: true });
    expect(reattached.status).toBe(200);
    expect(await reattached.json()).toMatchObject({ lifecycle_state: "active", generated_project_ids: activation.projectIds,
      effects: { generated_projects: "preserved", provider_connections: "unchanged" } });
    expect(storage.sql.exec("SELECT action,actor_id FROM space_blueprint_lifecycle_events WHERE space_id=? AND blueprint_id=? ORDER BY created_at,event_id", spaceId, blueprint.id).toArray())
      .toHaveLength(2);
    const status = await space.fetch(new Request(`http://space/blueprint-installations?${new URLSearchParams({ tenant_id: "tenant", space_id: spaceId })}`, {
      headers: { "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
    }));
    expect(await status.json()).toMatchObject({ installations: [{ lifecycle_state: "active", lifecycle_events: [
      { action: "reattached", actor_id: "owner-a" }, { action: "detached", actor_id: "owner-a" },
    ] }] });
  });

  it("persists owner acknowledgement against the exact signed extension requirement digest", async () => {
    const storage = createDOStorage(), secret = "template-extension-review-test-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret } as never);
    const blueprint = { id: "tpl_requirement_review", schemaVersion: "2.0" as const, metadata: {}, templateCategory: "support", projects: [
      { id: "support_project", name: "Support", kind: "DualPane" as const, templateMode: "cowork_studio" as const,
        viewports: {}, systemPrompt: "", initialTasks: [], starterFiles: [] },
    ],
      requiredExtensions: ["ext_support"], requiredCredentials: [], extensionRequirements: {
        knowledge: [{ extensionId: "ext_support", knowledgeId: "public_faq", purpose: "Answer published FAQ questions", access: "owner_published_external" as const, required: true }],
      } };
    const targetSpaceId = "template-requirement-review-space", token = await mintInternalToken(secret, "tenant");
    const activationUrl = "http://space/blueprints/instantiate";
    const selections = { support_project: { ext_support: ["public_faq"] } };
    const request = (review?: unknown, withToken = true) => space.fetch(new Request(activationUrl, { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", ...(withToken ? { "x-naelao-internal-token": token } : {}) },
      body: JSON.stringify({ blueprint, target_space_id: targetSpaceId, activation_key: blueprint.id, ...(review === undefined ? {} : { extension_requirements_review: review }) }) }));
    expect((await request({ reviewed_by: "owner-a", reviewed_at: "2026-11-14T00:00:00.000Z" }, false)).status).toBe(403);
    expect((await request()).status).toBe(400);
    const first = await request({ reviewed_by: "owner-a", reviewed_at: "2026-11-14T00:00:00.000Z", project_knowledge_selections: selections });
    expect(first.status).toBe(201);
    const activation = await first.json() as { projectIds: string[]; projectIdsByBlueprintId: Record<string, string> };
    const row = storage.sql.exec<{ extension_requirements_review_json: string }>(
      "SELECT extension_requirements_review_json FROM space_blueprint_installations WHERE space_id=? AND blueprint_id=?", targetSpaceId, blueprint.id).toArray()[0];
    expect(JSON.parse(row!.extension_requirements_review_json)).toMatchObject({ reviewed_by: "owner-a", requirements_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      project_knowledge_selections: selections });
    expect(storage.sql.exec("SELECT COUNT(*) AS total FROM extension_project_knowledge_grants").toArray()[0]?.total).toBe(0);
    const retry = await request({ reviewed_by: "owner-a", reviewed_at: "2026-11-14T00:01:00.000Z", project_knowledge_selections: selections });
    expect(retry.status).toBe(200);
    const changedRetry = await request({ reviewed_by: "owner-a", reviewed_at: "2026-11-14T00:02:00.000Z", project_knowledge_selections: {} });
    expect(changedRetry.status).toBe(409);
    const invalidSelection = await request({ reviewed_by: "owner-a", reviewed_at: "2026-11-14T00:02:00.000Z",
      project_knowledge_selections: { support_project: { ext_support: ["not_declared"] } } });
    expect(invalidSelection.status).toBe(400);
    const status = await space.fetch(new Request(`http://space/blueprint-installations?tenant_id=tenant&space_id=${targetSpaceId}`, {
      headers: { "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
    }));
    expect(await status.json()).toMatchObject({ installations: [{ extension_requirements_review: {
      reviewed_by: "owner-a", reviewed_at: "2026-11-14T00:00:00.000Z", requirements_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      project_knowledge_selections: { [activation.projectIds[0]!]: { ext_support: ["public_faq"] } },
    } }] });
  });

  it("previews and atomically applies an owner-confirmed setup-only migration with revision fences", async () => {
    const storage = createDOStorage(), secret = "template-setup-update-test-secret";
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret } as never);
    const targetSpaceId = "template-update-space";
    const blueprint = structuredClone(PERSONAL_ASSISTANT_SPACE_TEMPLATE);
    blueprint.setupSchemaVersion = 1;
    const project = blueprint.projects[0]!;
    project.id = "support";
    project.setupFields = [
      { id: "greeting", type: "text", label: "Greeting", required: true, minLength: 2, maxLength: 80 },
      { id: "weekly_hours", type: "number", label: "Weekly hours", defaultValue: 8, minimum: 1, maximum: 168 },
    ];
    const setupValues = { support: { greeting: "Welcome" } };
    const activated = await space.fetch(new Request("http://space/blueprints/instantiate", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" },
      body: JSON.stringify({ blueprint, target_space_id: targetSpaceId, activation_key: blueprint.id,
        listing_id: "listing-old", setup_values: setupValues }) }));
    expect(activated.status).toBe(201);
    const oldArtifactSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(blueprint))))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const oldSchemaSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(validateBlueprintSetupSchema(blueprint))))) ]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const candidate = structuredClone(blueprint);
    candidate.setupSchemaVersion = 2;
    candidate.projects[0]!.setupFields = [{ id: "welcome", type: "text", label: "Welcome message", required: true, minLength: 2, maxLength: 80 }];
    candidate.setupMigrations = [{ fromArtifactSha256: oldArtifactSha256, fromSchemaSha256: oldSchemaSha256, operations: [
      { kind: "rename", fromProjectId: "support", fromFieldId: "greeting", toProjectId: "support", toFieldId: "welcome" },
      { kind: "drop", projectId: "support", fieldId: "weekly_hours" },
    ] }];
    const newArtifactSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(candidate))))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const groups = validateBlueprintSetupSchema(candidate);
    const migrationUrl = `http://space/blueprint-installation-setup-update/preview?${new URLSearchParams({
      tenant_id: "tenant", space_id: targetSpaceId, blueprint_id: blueprint.id,
    })}`;
    const token = await mintInternalToken(secret, "tenant");
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "owner-a",
      "x-naelao-role": "owner", "x-naelao-internal-token": token };
    const updateBody = { expected_artifact_sha256: oldArtifactSha256, expected_listing_id: "listing-old", expected_setup_revision: 1,
      source_listing_id: "listing-new", source_artifact_sha256: newArtifactSha256, setup_schema_version: 2 as const,
      setup_schema_groups: groups, setup_migrations: candidate.setupMigrations };
    const preview = await space.fetch(new Request(migrationUrl, { method: "POST", headers, body: JSON.stringify(updateBody) }));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ values: { support: { welcome: "Welcome" } }, missing_required: [], setup_revision: 1,
      setup_migration_operations: [{ kind: "rename" }, { kind: "drop", projectId: "support", fieldId: "weekly_hours" }] });
    expect(storage.sql.exec("SELECT COUNT(*) AS total FROM space_template_setup_update_events").toArray()[0]?.total).toBe(0);
    const projectsBefore = storage.sql.exec("SELECT id,name FROM projects WHERE space_id=? ORDER BY id", targetSpaceId).toArray();

    const unconfirmedDrop = await space.fetch(new Request(migrationUrl.replace("/preview?", "/apply?"), { method: "POST", headers,
      body: JSON.stringify({ ...updateBody, confirmed: true, setup_values: { support: { welcome: "Welcome to the new schema" } } }) }));
    expect(unconfirmedDrop.status).toBe(400);
    const apply = await space.fetch(new Request(migrationUrl.replace("/preview?", "/apply?"), { method: "POST", headers,
      body: JSON.stringify({ ...updateBody, confirmed: true, confirm_data_loss: true,
        setup_values: { support: { welcome: "Welcome to the new schema" } } }) }));
    expect(apply.status).toBe(200);
    expect(await apply.json()).toMatchObject({ applied: true, artifact_sha256: newArtifactSha256, listing_id: "listing-new", setup_revision: 2 });
    expect(storage.sql.exec("SELECT artifact_sha256,listing_id,setup_schema_version,setup_revision,setup_values_json FROM space_blueprint_installations WHERE space_id=? AND blueprint_id=?", targetSpaceId, blueprint.id).toArray()[0])
      .toMatchObject({ artifact_sha256: newArtifactSha256, listing_id: "listing-new", setup_schema_version: 2, setup_revision: 2,
        setup_values_json: JSON.stringify({ support: { welcome: "Welcome to the new schema" } }) });
    expect(storage.sql.exec("SELECT actor_id,from_setup_revision,to_setup_revision FROM space_template_setup_update_events").toArray())
      .toEqual([{ actor_id: "owner-a", from_setup_revision: 1, to_setup_revision: 2 }]);
    expect(storage.sql.exec("SELECT id,name FROM projects WHERE space_id=? ORDER BY id", targetSpaceId).toArray()).toEqual(projectsBefore);
    const stale = await space.fetch(new Request(migrationUrl.replace("/preview?", "/apply?"), { method: "POST", headers,
      body: JSON.stringify({ ...updateBody, confirmed: true, confirm_data_loss: true, setup_values: { support: { welcome: "Stale" } } }) }));
    expect(stale.status).toBe(409);
  });

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
