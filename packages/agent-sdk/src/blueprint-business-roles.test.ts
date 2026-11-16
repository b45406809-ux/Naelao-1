import { describe, expect, it } from "vitest";
import { instantiateBlueprint } from "./blueprint.js";
import { authorBlueprintBusinessRoles, validateBlueprintBusinessRoles } from "./blueprint-business-roles.js";
import type { SpaceBlueprint } from "./types.js";

const legacy: SpaceBlueprint = { id: "bp_legacy", schemaVersion: "2.0", metadata: {}, templateCategory: "general",
  projects: [{ id: "accounts", name: "Accounts", kind: "DualPane", templateMode: "cowork_studio", viewports: {},
    systemPrompt: "Work carefully", initialTasks: [], starterFiles: [] }], requiredExtensions: ["ext_finance", "ext_stock"], requiredCredentials: [],
  extensionRequirements: { knowledge: [{ extensionId: "ext_finance", knowledgeId: "finance_faq", purpose: "Approved finance guidance", access: "member_only", required: false }] } };

const roles = [
  { id: "stock_lead", name: { en: "Stock lead" }, resourceRequests: [{ resource: { kind: "microapp", extensionId: "ext_stock", microappId: "inventory" },
    actions: ["stock.read"], purpose: { en: "Review stock records" } },
    { resource: { kind: "shared_data", projectId: "accounts", extensionId: "ext_stock", microappId: "inventory", collectionId: "batches" },
      actions: ["read", "write"], purpose: { en: "Maintain shared inventory batches" } }] },
  { id: "accountant", name: { "en-US": "Accountant", en: " Accountant " }, description: { en: "Reviews business accounts" },
    recommendedSpaceRole: "member" as const,
    resourceRequests: [
      { resource: { kind: "knowledge" as const, extensionId: "ext_finance", knowledgeId: "finance_faq" }, actions: ["knowledge.use"], purpose: { en: "Read approved financial guidance" } },
      { resource: { kind: "project" as const, projectId: "accounts" }, actions: ["records.write", "records.read"], purpose: { en: "Maintain shared accounting records" } },
    ],
    assistant: { mode: "read_only" as const, instructions: { en: "Use only records currently available to the member." }, allowedActions: ["records.read"] },
    onboardingSteps: [{ id: "review-policy", title: { en: "Review policy" }, instructions: { en: "Read the business record policy." }, required: true }],
    spendingSuggestion: { monthlyCredits: 200, approvalActions: ["payments.submit"] },
  },
];

describe("template-defined business role proposals", () => {
  it("provides a builder round-trip helper that canonicalizes proposals without adding authority", () => {
    const authored = authorBlueprintBusinessRoles(legacy, roles);
    expect(authored.businessRolesSchemaVersion).toBe(1);
    expect(authored.businessRoles?.map(role => role.id)).toEqual(["accountant", "stock_lead"]);
    expect(authored).not.toHaveProperty("grants");
    expect(instantiateBlueprint(authored, "space-target").businessRoles).toEqual(authored.businessRoles);
    expect(legacy).not.toHaveProperty("businessRoles");
  });

  it("preserves legacy templates and canonicalizes arbitrary signed role proposals without creating grants", () => {
    const old = instantiateBlueprint(legacy, "space-target");
    expect(old).not.toHaveProperty("businessRoles");
    expect(old).not.toHaveProperty("businessRolesSchemaVersion");

    const compiled = instantiateBlueprint({ ...legacy, businessRolesSchemaVersion: 1, businessRoles: roles }, "space-target");
    expect(compiled.businessRoles?.map((role) => role.id)).toEqual(["accountant", "stock_lead"]);
    expect(compiled.businessRoles?.[0]).toMatchObject({ name: { en: "Accountant", "en-us": "Accountant" },
      recommendedSpaceRole: "member", assistant: { mode: "read_only" }, spendingSuggestion: { monthlyCredits: 200 } });
    expect(compiled.businessRoles?.[0]?.resourceRequests?.map((request) => request.actions)).toContainEqual(["records.read", "records.write"]);
    expect(compiled.businessRoles?.[0]?.resourceRequests?.every((request) => "resource" in request)).toBe(true);
    expect(compiled.businessRoles?.[1]?.resourceRequests).toContainEqual(expect.objectContaining({ resource: {
      kind: "shared_data", projectId: "accounts", extensionId: "ext_stock", microappId: "inventory", collectionId: "batches",
    } }));
  });

  it("rejects duplicate roles/resources/actions, unknown fields, privileged owner suggestions and undeclared references", () => {
    const context = { projects: legacy.projects, requiredExtensions: legacy.requiredExtensions, extensionRequirements: legacy.extensionRequirements };
    expect(() => validateBlueprintBusinessRoles([roles[1], roles[1]], context)).toThrow("Invalid or duplicate business role");
    expect(() => instantiateBlueprint({ ...legacy, businessRolesSchemaVersion: 1, businessRoles: [{ ...roles[1], hiddenGrant: true }] as never }, "space"))
      .toThrow("Invalid or duplicate business role");
    expect(() => validateBlueprintBusinessRoles([{ id: "accountant", name: { en: "Accountant" }, recommendedSpaceRole: "owner" }], context))
      .toThrow("Invalid business role Space role suggestion");
    expect(() => validateBlueprintBusinessRoles([{ id: "accountant", name: { en: "Accountant" }, resourceRequests: [
      { resource: { kind: "project", projectId: "outside" }, actions: ["records.read"], purpose: { en: "Read" } },
    ] }], context)).toThrow("Invalid or undeclared business role resource reference");
    expect(() => validateBlueprintBusinessRoles([{ id: "accountant", name: { en: "Accountant" }, resourceRequests: [
      { resource: { kind: "knowledge", extensionId: "ext_finance", knowledgeId: "unlisted" }, actions: ["knowledge.use"], purpose: { en: "Read" } },
    ] }], context)).toThrow("Invalid or undeclared business role resource reference");
    expect(() => validateBlueprintBusinessRoles([{ id: "accountant", name: { en: "Accountant" }, resourceRequests: [
      { resource: { kind: "knowledge", extensionId: "ext_finance", knowledgeId: "finance_faq" }, actions: ["read"], purpose: { en: "Read" } },
      { resource: { kind: "collection", extensionId: "ext_finance", collectionId: "finance_faq" }, actions: ["read"], purpose: { en: "Read" } },
    ] }], context)).toThrow("Duplicate business role resource request");
  });

  it("requires the explicit schema version and enforces total count and serialized byte bounds", () => {
    expect(() => instantiateBlueprint({ ...legacy, businessRoles: roles } as never, "space")).toThrow("Unsupported business role schema version");
    expect(() => validateBlueprintBusinessRoles(Array.from({ length: 33 }, (_, index) => ({ id: `role_${index}`, name: { en: "Role" } })), {
      projects: [], requiredExtensions: [],
    })).toThrow("Invalid business role list");
    expect(() => validateBlueprintBusinessRoles([{ id: "accountant", name: { en: "Accountant" }, description: { en: "a".repeat(70_000) } }], {
      projects: [], requiredExtensions: [],
    })).toThrow("Invalid business role localization");
    expect(() => validateBlueprintBusinessRoles(Array.from({ length: 32 }, (_, index) => ({
      id: `role_${index}`, name: { en: `Role ${index}` }, assistant: { instructions: { en: "x".repeat(2_000) } },
    })), { projects: [], requiredExtensions: [] })).toThrow("Business role proposals exceed the size limit");
  });

  it("rejects ambiguous signed project symbols when roles reference projects", () => {
    expect(() => validateBlueprintBusinessRoles([{ id: "accountant", name: { en: "Accountant" }, resourceRequests: [
      { resource: { kind: "project", projectId: "accounts" }, actions: ["records.read"], purpose: { en: "Read records" } },
    ] }], { projects: [{ id: "accounts" }, { id: "accounts" }], requiredExtensions: [] })).toThrow("Duplicate business role project reference");
  });
});
