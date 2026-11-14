import { describe, expect, it } from "vitest";
import { instantiateBlueprint, validateBlueprintExtensionRequirements } from "./blueprint.js";
import type { SpaceBlueprint } from "./types.js";

const valid: SpaceBlueprint = { id: "bp", schemaVersion: "2.0", metadata: {}, templateCategory: "venture", requiredExtensions: [], requiredCredentials: [], projects: [{ name: "App", kind: "DualPane", templateMode: "cowork_studio", viewports: {}, systemPrompt: "Build safely", initialTasks: [{ title: "Start" }], starterFiles: [{ path: "/workspace/src/index.ts", content: "export {};" }] }] };

describe("blueprint compiler", () => {
  it("validates, detaches and normalizes starter paths", () => {
    const compiled = instantiateBlueprint(valid, "space_target");
    expect(compiled).not.toBe(valid);
    expect(compiled.metadata.targetSpaceId).toBe("space_target");
    expect(compiled.projects[0]?.starterFiles[0]?.path).toBe("src/index.ts");
  });
  it("rejects traversal", () => expect(() => instantiateBlueprint({ ...valid, projects: [{ ...valid.projects[0]!, starterFiles: [{ path: "../secret", content: "" }] }] }, "space")).toThrow("Unsafe"));
  it("accepts only a boolean member-facts coordination default", () => {
    expect(instantiateBlueprint({ ...valid, coordinationDefaults: { memberFactsEnabled: true } }, "space").coordinationDefaults)
      .toEqual({ memberFactsEnabled: true });
    expect(() => instantiateBlueprint({ ...valid, coordinationDefaults: { memberFactsEnabled: "yes" } as never }, "space"))
      .toThrow("Invalid coordination defaults");
    expect(() => instantiateBlueprint({ ...valid, coordinationDefaults: { memberFactsEnabled: false, publishFacts: true } as never }, "space"))
      .toThrow("Invalid coordination defaults");
  });
  it("accepts a bounded canonical singleton-key suggestion without requiring a visibility default", () => {
    expect(instantiateBlueprint({ ...valid, coordinationDefaults: { singletonCapabilityKeys: ["service.phone", "official.website"] } }, "space").coordinationDefaults)
      .toEqual({ singletonCapabilityKeys: ["official.website", "service.phone"] });
    expect(() => instantiateBlueprint({ ...valid, coordinationDefaults: { singletonCapabilityKeys: ["Official.Website"] } }, "space"))
      .toThrow("Invalid coordination defaults");
    expect(() => instantiateBlueprint({ ...valid, coordinationDefaults: { singletonCapabilityKeys: ["official.website", "official.website"] } }, "space"))
      .toThrow("Invalid coordination defaults");
    expect(() => instantiateBlueprint({ ...valid, coordinationDefaults: { singletonCapabilityKeys: [] } }, "space"))
      .toThrow("Invalid coordination defaults");
  });
  it("requires dependency pins to name declared dependencies with valid release versions", () => {
    expect(() => instantiateBlueprint({ ...valid, requiredExtensionVersions: { ext_undeclared: "1.0.0" } }, "space")).toThrow("Invalid required extension version");
    expect(() => instantiateBlueprint({ ...valid, requiredExtensions: ["ext_demo"], requiredExtensionVersions: { ext_demo: "latest" } }, "space")).toThrow("Invalid required extension version");
    expect(instantiateBlueprint({ ...valid, requiredExtensions: ["ext_demo"], requiredExtensionVersions: { ext_demo: "1.2.3" } }, "space").requiredExtensionVersions).toEqual({ ext_demo: "1.2.3" });
  });
  it("validates signed knowledge and action references against declared extension dependencies", () => {
    const requirements = { knowledge: [{ extensionId: "ext_support", knowledgeId: "public_faq", purpose: "Answer published FAQ", access: "owner_published_external" as const, required: true }],
      actions: [{ extensionId: "ext_support", primitiveId: "booking", scope: "PROJECT_BOUND" as const, resource: "calendar.events", action: "execute" as const, purpose: "Create approved bookings", required: true }] };
    const compiled = instantiateBlueprint({ ...valid, requiredExtensions: ["ext_support"], extensionRequirements: requirements }, "space");
    expect(compiled.extensionRequirements).toEqual(requirements);
    expect(() => validateBlueprintExtensionRequirements(requirements, [])).toThrow("Invalid knowledge requirement");
    expect(() => validateBlueprintExtensionRequirements({ ...requirements, knowledge: [requirements.knowledge[0], requirements.knowledge[0]] }, ["ext_support"]))
      .toThrow("Duplicate knowledge requirement");
    expect(() => validateBlueprintExtensionRequirements({ ...requirements, privileged: true }, ["ext_support"]))
      .toThrow("Invalid extension requirements");
  });
});
