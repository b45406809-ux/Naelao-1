import { describe, expect, it } from "vitest";
import { instantiateBlueprint } from "./blueprint.js";
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
  it("requires dependency pins to name declared dependencies with valid release versions", () => {
    expect(() => instantiateBlueprint({ ...valid, requiredExtensionVersions: { ext_undeclared: "1.0.0" } }, "space")).toThrow("Invalid required extension version");
    expect(() => instantiateBlueprint({ ...valid, requiredExtensions: ["ext_demo"], requiredExtensionVersions: { ext_demo: "latest" } }, "space")).toThrow("Invalid required extension version");
    expect(instantiateBlueprint({ ...valid, requiredExtensions: ["ext_demo"], requiredExtensionVersions: { ext_demo: "1.2.3" } }, "space").requiredExtensionVersions).toEqual({ ext_demo: "1.2.3" });
  });
});
