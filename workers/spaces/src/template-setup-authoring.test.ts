import { describe, expect, it } from "vitest";
import { digestExtensionManifest, type SpaceBlueprint, validateBlueprintSetupSchema, validateExtensionManifest } from "@naelao/agent-sdk";
import { attachBlueprintAssistantChannelDefaults, attachBlueprintCoordinationDefaults, attachBlueprintExtensionRequirements, attachBlueprintSetupFields, attachBlueprintSetupFieldGroups } from "./template-setup-authoring.js";
import spacesWorker from "./index.js";

const sourceBlueprint = (): SpaceBlueprint => ({
  id: "tpl_customer_support",
  schemaVersion: "2.0",
  metadata: { name: "Customer support" },
  templateCategory: "support",
  projects: [
    { id: "support", name: "Support", kind: "DualPane", templateMode: "cowork_studio", viewports: {},
      systemPrompt: "", initialTasks: [], starterFiles: [{ path: "/workspace/eval/conformance.ts", content: "export async function run() {}" }] },
    { id: "6f9619ff-8b86-d011-b42d-00cf4fc964ff", name: "Billing", kind: "DualPane", templateMode: "cowork_studio", viewports: {},
      systemPrompt: "", initialTasks: [], starterFiles: [{ path: "/workspace/eval/billing.ts", content: "export async function run() {}" }] },
  ],
  requiredExtensions: [],
  requiredCredentials: [],
});

const setupFields = [
  { id: "contact_enabled", type: "boolean" as const, label: "Enable the contact form", defaultValue: true },
  { id: "contact_email", type: "text" as const, label: "Contact email", required: true, maxLength: 120,
    visibleWhen: { fieldId: "contact_enabled", equals: true },
    localization: { label: { en: "Contact email", es: "Correo de contacto" } } },
];

const requirementManifest = validateExtensionManifest({
  id: "ext_support", type: "extension", declaredPermissions: [], capabilityRequirements: ["extension.project_canvas"], gadgets: [], daemons: [], commands: [],
  bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_support", version: "1.0.0",
    knowledge: [{ id: "public_faq", purpose: "Answer published FAQ questions", access: "owner_published_external" }],
    primitives: [{ schemaVersion: "1.0", kind: "canvas", id: "booking", version: "1.0.0",
      permissions: [{ scope: "PROJECT_BOUND", actions: ["execute"], resource: "calendar.events" }], capabilityRequirements: [], lifecycle: {},
      component: "./booking.html", layout: "CanvasMount", dynamicPage: false }],
  },
});

function exportHarness() {
  const blueprint = sourceBlueprint(), writes: Array<{ key: string; text: string }> = [], jobs: unknown[] = [], spaceRequests: Request[] = [];
  const exportRequests = new Map<string, { id: string; artifact_key: string; request_sha256: string }>(), artifacts = new Map<string, string>(), workflows = new Map<string, unknown>();
  const env = {
    PLATFORM_SECRET: "template-setup-authoring-secret",
    PLATFORM_DB: { prepare: (query: string) => ({ bind: (...values: unknown[]) => ({
      first: async () => {
        if (query.includes("FROM spaces WHERE id")) return { id: "space-studio" };
        if (query.includes("FROM blueprint_export_jobs") && query.includes("request_id=?"))
          return exportRequests.get(`${values[0]}:${values[1]}:${values[2]}`) ?? null;
        return null;
      },
      run: async () => {
        if (query.includes("INSERT OR IGNORE INTO blueprint_export_jobs")) {
          const key = `${values[1]}:${values[2]}:${values[4]}`;
          if (exportRequests.has(key)) return { success: true, meta: { changes: 0 } };
          exportRequests.set(key, { id: String(values[0]), artifact_key: String(values[3]), request_sha256: String(values[5]) });
        }
        return { success: true, meta: { changes: 1 } };
      },
      all: async () => ({ results: [{ key_id: "a".repeat(64) }] }),
    }) }) },
    SPACE_DO: { idFromName: () => "space-studio-do", get: () => ({ fetch: async (request: Request) => {
      spaceRequests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/extensions" && request.method === "GET") return Response.json({ extensions: [{ manifest: requirementManifest }] });
      if (path === "/extension-releases") return Response.json({ releases: [{ version: "1.0.0", signatureValid: true,
        publisher: { keyId: "a".repeat(64) } }] });
      const body = await request.clone().json() as { project_id?: string; project_ids?: string[] };
      const selected = body.project_ids ? new Set(body.project_ids) : body.project_id ? new Set([body.project_id]) : null;
      return Response.json(selected ? { ...blueprint, projects: blueprint.projects.filter(project => selected.has(project.id!)) } : blueprint);
    } }) },
    SCRIPTS_R2: { put: async (key: string, value: string) => { writes.push({ key, text: value }); artifacts.set(key, value); },
      get: async (key: string) => artifacts.has(key) ? { text: async () => artifacts.get(key)! } : null,
      delete: async (key: string) => { artifacts.delete(key); } },
    BLUEPRINT_CONFORMANCE_WORKFLOW: { create: async (job: { id: string }) => { if (workflows.has(job.id)) throw new Error("workflow_exists"); jobs.push(job); workflows.set(job.id, { ...job, status: async () => ({ status: "running" }) }); },
      get: async (id: string) => { const workflow = workflows.get(id); if (!workflow) throw new Error("workflow_missing"); return workflow; } },
    LOADER: {}, CONFORMANCE_SANDBOX_DO: {}, CONFORMANCE_EXECUTOR: {},
  } as never;
  return { blueprint, env, writes, jobs, spaceRequests, exportRequests, artifacts };
}

function conformanceSuite(projectCount = 1) {
  return { fixtures: Array.from({ length: 50 }, (_, index) => ({
    id: `fixture-${index}`, projectIndex: index % projectCount, input: {}, seed: { schema: [], statements: [], files: {} },
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

  it("attaches separate bounded setup groups to multiple exact exported projects", () => {
    const source = sourceBlueprint();
    const groups = {
      support: setupFields,
      "6f9619ff-8b86-d011-b42d-00cf4fc964ff": [{ id: "currency", type: "select" as const, label: "Currency", options: [{ value: "usd", label: "USD" }] }],
    };
    const authored = attachBlueprintSetupFieldGroups(source, { schemaVersion: 2, fieldsByProject: groups });
    expect(validateBlueprintSetupSchema(authored)).toEqual([
      { project_id: "support", project_name: "Support", fields: setupFields },
      { project_id: "6f9619ff-8b86-d011-b42d-00cf4fc964ff", project_name: "Billing", fields: groups["6f9619ff-8b86-d011-b42d-00cf4fc964ff"] },
    ]);
    expect(source.projects.every(project => project.setupFields === undefined)).toBe(true);
    expect(() => attachBlueprintSetupFieldGroups(source, { schemaVersion: 2, fieldsByProject: { private: setupFields } }))
      .toThrow("blueprint_setup_project_not_exported");
  });

  it("attaches only validated availability and phone-prompt defaults, never account provisioning", () => {
    const source = sourceBlueprint();
    const defaults = { spaceAssistant: { enabled: { chat: true, phone: false }, phonePrompt: "recommended" as const },
      projectAssistants: { enabled: { email: false } } };
    const authored = attachBlueprintAssistantChannelDefaults(source, defaults);
    expect(authored.assistantChannels).toEqual(defaults);
    expect(source.assistantChannels).toBeUndefined();
    expect(() => attachBlueprintAssistantChannelDefaults(source, { spaceAssistant: { enabled: { unknown: true } } })).toThrow();
    expect(() => attachBlueprintAssistantChannelDefaults(source, { emailProvisioning: { spaceAssistant: {
      provider: "agentmail", defaultMode: "naelao_managed", provisionOnCreate: true,
    } } })).toThrow("blueprint_assistant_channel_provisioning_not_authorable");
  });

  it("attaches only the signed member-facts suggestion without mutating the source", () => {
    const source = sourceBlueprint();
    const authored = attachBlueprintCoordinationDefaults(source, { memberFactsEnabled: true });
    expect(authored.coordinationDefaults).toEqual({ memberFactsEnabled: true });
    expect(source.coordinationDefaults).toBeUndefined();
    expect(() => attachBlueprintCoordinationDefaults(source, { memberFactsEnabled: "yes" })).toThrow("blueprint_coordination_defaults_invalid");
    expect(() => attachBlueprintCoordinationDefaults(source, { memberFactsEnabled: false, revealProjects: true })).toThrow("blueprint_coordination_defaults_invalid");
  });

  it("attaches only canonical bounded singleton-key suggestions, including without a member visibility default", () => {
    const source = sourceBlueprint();
    const authored = attachBlueprintCoordinationDefaults(source, { singletonCapabilityKeys: ["service.phone", "official.website"] });
    expect(authored.coordinationDefaults).toEqual({ singletonCapabilityKeys: ["official.website", "service.phone"] });
    expect(source.coordinationDefaults).toBeUndefined();
    expect(() => attachBlueprintCoordinationDefaults(source, { singletonCapabilityKeys: [] })).toThrow("blueprint_coordination_defaults_invalid");
    expect(() => attachBlueprintCoordinationDefaults(source, { singletonCapabilityKeys: ["official.website", "official.website"] })).toThrow("blueprint_coordination_defaults_invalid");
    expect(() => attachBlueprintCoordinationDefaults(source, { singletonCapabilityKeys: ["Official.Website"] })).toThrow("blueprint_coordination_defaults_invalid");
  });

  it("authors only exact dependency knowledge and action references", () => {
    const source = sourceBlueprint();
    source.requiredExtensions = ["ext_support"];
    const requirements = { knowledge: [{ extensionId: "ext_support", knowledgeId: "public_faq", purpose: "Answer public FAQ questions", access: "owner_published_external" as const, required: true }],
      actions: [{ extensionId: "ext_support", primitiveId: "booking", scope: "PROJECT_BOUND" as const, resource: "calendar.events", action: "execute" as const, purpose: "Create an approved booking", required: true }] };
    const authored = attachBlueprintExtensionRequirements(source, requirements);
    expect(authored.extensionRequirements).toEqual(requirements);
    expect(source.extensionRequirements).toBeUndefined();
    expect(() => attachBlueprintExtensionRequirements(source, { knowledge: [{ ...requirements.knowledge[0], extensionId: "ext_other" }] }))
      .toThrow("Invalid knowledge requirement");
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
    h.blueprint.requiredExtensions = ["ext_support"];
    h.blueprint.requiredExtensionVersions = { ext_support: "1.0.0" };
    h.blueprint.requiredExtensionDigests = { ext_support: await digestExtensionManifest(requirementManifest) };
    const extensionRequirements = { knowledge: [{ extensionId: "ext_support", knowledgeId: "public_faq", purpose: "Answer public FAQ questions", access: "owner_published_external", required: true }],
      actions: [{ extensionId: "ext_support", primitiveId: "booking", scope: "PROJECT_BOUND", resource: "calendar.events", action: "execute", purpose: "Create an approved booking", required: true }] };
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/space-studio/export-template", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-studio",
        "x-naelao-user-id": "owner-studio", "x-naelao-role": "owner" },
      body: JSON.stringify({ projectId: "support", requiredExtensions: [], name: "Support", description: "Support template",
        setupSchemaVersion: 2, setupFields,
        assistantChannels: { spaceAssistant: { enabled: { chat: true, phone: false }, phonePrompt: "recommended" }, projectAssistants: { enabled: { email: false } } },
        coordinationDefaults: { memberFactsEnabled: true, singletonCapabilityKeys: ["service.phone", "official.website"] },
        extensionRequirements,
        stateDeltaSuite: conformanceSuite(), entries: { support: "/workspace/eval/conformance.ts" } }),
    }), h.env);
    expect(response.status, await response.clone().text()).toBe(202);
    expect(h.spaceRequests.map(request => new URL(request.url).pathname)).toEqual([
      "/blueprints/export", "/extension-releases", "/extensions",
    ]);
    expect(h.jobs).toHaveLength(1);
    const payload = JSON.parse(h.writes[0]!.text) as { blueprint: SpaceBlueprint };
    expect(payload.blueprint).toMatchObject({ setupSchemaVersion: 2, projects: expect.arrayContaining([expect.objectContaining({ id: "support", setupFields })]),
      assistantChannels: { spaceAssistant: { enabled: { chat: true, phone: false }, phonePrompt: "recommended" }, projectAssistants: { enabled: { email: false } } },
      coordinationDefaults: { memberFactsEnabled: true, singletonCapabilityKeys: ["official.website", "service.phone"] },
      extensionRequirements,
      metadata: { stateDeltaSuite: { fixtures: expect.arrayContaining([expect.objectContaining({ id: "fixture-0" })]) } } });
  });

  it("rejects requirement references absent from the exact pinned package manifest", async () => {
    const h = exportHarness();
    h.blueprint.requiredExtensions = ["ext_support"];
    h.blueprint.requiredExtensionVersions = { ext_support: "1.0.0" };
    h.blueprint.requiredExtensionDigests = { ext_support: await digestExtensionManifest(requirementManifest) };
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/space-studio/export-template", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-studio",
        "x-naelao-user-id": "owner-studio", "x-naelao-role": "owner" },
      body: JSON.stringify({ projectId: "support", name: "Support", description: "Support template",
        extensionRequirements: { knowledge: [{ extensionId: "ext_support", knowledgeId: "not_declared", purpose: "Answer FAQs",
          access: "owner_published_external", required: false }] },
        stateDeltaSuite: conformanceSuite(), entries: { support: "/workspace/eval/conformance.ts" } }),
    }), h.env);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error_code: "blueprint_extension_requirement_manifest_mismatch" });
    expect(h.writes).toHaveLength(0);
    expect(h.jobs).toHaveLength(0);
  });

  it("exports multiple selected projects and their separate setup groups through owner validation", async () => {
    const h = exportHarness();
    const billingProjectId = "6f9619ff-8b86-d011-b42d-00cf4fc964ff";
    const billingFields = [{ id: "currency", type: "select", label: "Currency", options: [{ value: "usd", label: "USD" }] }];
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/space-studio/export-template", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-studio",
        "x-naelao-user-id": "owner-studio", "x-naelao-role": "owner" },
      body: JSON.stringify({ projectIds: ["support", billingProjectId], requiredExtensions: [], name: "Support and billing",
        setupSchemaVersion: 2, setupFieldsByProject: { support: setupFields, [billingProjectId]: billingFields },
        stateDeltaSuite: conformanceSuite(2), entries: { support: "/workspace/eval/conformance.ts", [billingProjectId]: "/workspace/eval/billing.ts" } }),
    }), h.env);
    expect(response.status, await response.clone().text()).toBe(202);
    expect(await h.spaceRequests[0]!.clone().json()).toMatchObject({ project_ids: ["support", billingProjectId] });
    const payload = JSON.parse(h.writes[0]!.text) as { blueprint: SpaceBlueprint };
    expect(validateBlueprintSetupSchema(payload.blueprint)).toEqual([
      { project_id: "support", project_name: "Support", fields: setupFields },
      { project_id: billingProjectId, project_name: "Billing", fields: billingFields },
    ]);
  });

  it("reconciles a lost export response by request ID and rejects changed input under the same key", async () => {
    const h = exportHarness(), requestId = "d8d5f430-8d8a-4ea7-a33d-16ec59ce01a5";
    const body = { requestId, projectId: "support", requiredExtensions: [], name: "Support", description: "Support template",
      stateDeltaSuite: conformanceSuite(), entries: { support: "/workspace/eval/conformance.ts" } };
    const request = (payload: unknown) => spacesWorker.fetch(new Request("https://spaces.test/spaces/space-studio/export-template", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-studio",
        "x-naelao-user-id": "owner-studio", "x-naelao-role": "owner" }, body: JSON.stringify(payload),
    }), h.env);
    const [first, retry] = await Promise.all([request(body), request(body)]);
    const [firstResult, retryResult] = await Promise.all([first.json(), retry.json()]) as [{ jobId: string }, { jobId: string }];
    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(retryResult.jobId).toBe(firstResult.jobId);
    expect(h.jobs).toHaveLength(1);
    expect(h.artifacts.size).toBe(1);
    const recovered = await spacesWorker.fetch(new Request(`https://spaces.test/spaces/space-studio/export-template?request_id=${requestId}`, {
      headers: { "x-naelao-tenant-id": "tenant-studio", "x-naelao-user-id": "owner-studio", "x-naelao-role": "owner" },
    }), h.env);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ found: true, jobId: firstResult.jobId, status: "running" });
    const conflict = await request({ ...body, description: "Changed authoring input" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error_code: "export_request_id_reused_with_different_input" });
    expect(h.jobs).toHaveLength(1);
    expect(h.artifacts.size).toBe(1);
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

  it("rejects invalid channel defaults and provisioning directives before storing an artifact", async () => {
    const h = exportHarness();
    const request = (assistantChannels: unknown) => spacesWorker.fetch(new Request("https://spaces.test/spaces/space-studio/export-template", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-studio",
        "x-naelao-user-id": "owner-studio", "x-naelao-role": "owner" },
      body: JSON.stringify({ projectId: "support", assistantChannels, stateDeltaSuite: conformanceSuite(), entries: { support: "/workspace/eval/conformance.ts" } }),
    }), h.env);
    expect((await request({ spaceAssistant: { enabled: { fax: true } } })).status).toBe(422);
    expect((await request({ emailProvisioning: { spaceAssistant: { provider: "agentmail", defaultMode: "naelao_managed", provisionOnCreate: true } } })).status).toBe(422);
    expect(h.writes).toHaveLength(0);
    expect(h.jobs).toHaveLength(0);
  });
});
