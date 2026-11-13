import { describe, expect, it } from "vitest";
import { type SpaceBlueprint, validateBlueprintSetupSchema } from "@naelao/agent-sdk";
import { attachBlueprintSetupFields } from "./template-setup-authoring.js";
import spacesWorker from "./index.js";

const sourceBlueprint = (): SpaceBlueprint => ({
  id: "tpl_customer_support",
  schemaVersion: "2.0",
  metadata: { name: "Customer support" },
  templateCategory: "support",
  projects: [{ id: "support", name: "Support", kind: "DualPane", templateMode: "cowork_studio", viewports: {},
    systemPrompt: "", initialTasks: [], starterFiles: [{ path: "/workspace/eval/conformance.ts", content: "export async function run() {}" }] }],
  requiredExtensions: [],
  requiredCredentials: [],
});

const setupFields = [
  { id: "contact_enabled", type: "boolean" as const, label: "Enable the contact form", defaultValue: true },
  { id: "contact_email", type: "text" as const, label: "Contact email", required: true, maxLength: 120,
    visibleWhen: { fieldId: "contact_enabled", equals: true },
    localization: { label: { en: "Contact email", es: "Correo de contacto" } } },
];

function exportHarness() {
  const blueprint = sourceBlueprint(), writes: Array<{ key: string; text: string }> = [], jobs: unknown[] = [], spaceRequests: Request[] = [];
  const env = {
    PLATFORM_SECRET: "template-setup-authoring-secret",
    PLATFORM_DB: { prepare: (query: string) => ({ bind: (..._values: unknown[]) => ({
      first: async () => query.includes("FROM spaces WHERE id") ? { id: "space-studio" } : null,
      run: async () => ({ success: true, meta: { changes: 1 } }),
    }) }) },
    SPACE_DO: { idFromName: () => "space-studio-do", get: () => ({ fetch: async (request: Request) => {
      spaceRequests.push(request);
      return Response.json(blueprint);
    } }) },
    SCRIPTS_R2: { put: async (key: string, value: string) => { writes.push({ key, text: value }); } },
    BLUEPRINT_CONFORMANCE_WORKFLOW: { create: async (job: unknown) => { jobs.push(job); } },
    LOADER: {}, CONFORMANCE_SANDBOX_DO: {}, CONFORMANCE_EXECUTOR: {},
  } as never;
  return { blueprint, env, writes, jobs, spaceRequests };
}

function conformanceSuite() {
  return { fixtures: Array.from({ length: 50 }, (_, index) => ({
    id: `fixture-${index}`, projectIndex: 0, input: {}, seed: { schema: [], statements: [], files: {} },
    assertions: [{ sql: "SELECT 1", rows: [[1]] }], expectedFiles: {},
  })) };
}

describe("visual Template setup authoring export", () => {
  it("attaches localized and conditional declarations only to the selected project using SDK validation", () => {
    const source = sourceBlueprint();
    const authored = attachBlueprintSetupFields(source, { projectId: "support", schemaVersion: 2, fields: setupFields });
    expect(validateBlueprintSetupSchema(authored)).toEqual([{ project_id: "support", project_name: "Support", fields: setupFields }]);
    expect(source.projects[0]?.setupFields).toBeUndefined();
    expect(authored.setupSchemaVersion).toBe(2);
  });

  it("rejects secrets, unknown exported projects, malformed fields and unbounded field lists", () => {
    const source = sourceBlueprint();
    expect(() => attachBlueprintSetupFields(source, { projectId: "support", schemaVersion: 1,
      fields: [{ id: "api_key", type: "text", label: "Provider details" }] })).toThrow();
    expect(() => attachBlueprintSetupFields(source, { projectId: "private", schemaVersion: 1, fields: setupFields })).toThrow("blueprint_setup_project_not_exported");
    expect(() => attachBlueprintSetupFields(source, { projectId: "support", schemaVersion: 1, fields: [{ id: "bad", type: "custom", label: "Bad" }] })).toThrow();
    expect(() => attachBlueprintSetupFields(source, { projectId: "support", schemaVersion: 2,
      fields: Array.from({ length: 33 }, (_, index) => ({ id: `field_${index}`, type: "text", label: `Field ${index}` })) })).toThrow("blueprint_setup_fields_invalid");
  });

  it("sends the visual declarations through owner export, SDK validation and conformance artifact storage", async () => {
    const h = exportHarness();
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/space-studio/export-template", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-studio",
        "x-naelao-user-id": "owner-studio", "x-naelao-role": "owner" },
      body: JSON.stringify({ projectId: "support", requiredExtensions: [], name: "Support", description: "Support template",
        setupSchemaVersion: 2, setupFields, stateDeltaSuite: conformanceSuite(), entries: { support: "/workspace/eval/conformance.ts" } }),
    }), h.env);
    expect(response.status, await response.clone().text()).toBe(202);
    expect(h.spaceRequests).toHaveLength(1);
    expect(h.jobs).toHaveLength(1);
    const payload = JSON.parse(h.writes[0]!.text) as { blueprint: SpaceBlueprint };
    expect(payload.blueprint).toMatchObject({ setupSchemaVersion: 2, projects: [{ id: "support", setupFields }],
      metadata: { stateDeltaSuite: { fixtures: expect.arrayContaining([expect.objectContaining({ id: "fixture-0" })]) } } });
  });

  it("requires owner authorization and rejects credential-like fields before creating an export job", async () => {
    const h = exportHarness();
    const request = (role: string, fields: unknown) => spacesWorker.fetch(new Request("https://spaces.test/spaces/space-studio/export-template", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-studio",
        "x-naelao-user-id": "user-studio", "x-naelao-role": role },
      body: JSON.stringify({ projectId: "support", setupSchemaVersion: 1, setupFields: fields, stateDeltaSuite: conformanceSuite(), entries: { support: "/workspace/eval/conformance.ts" } }),
    }), h.env);
    expect((await request("member", setupFields)).status).toBe(403);
    const invalid = await request("owner", [{ id: "api_key", type: "text", label: "API key" }]);
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error_code: "blueprint_setup_schema_invalid" });
    expect(h.writes).toHaveLength(0);
    expect(h.jobs).toHaveLength(0);
  });
});
