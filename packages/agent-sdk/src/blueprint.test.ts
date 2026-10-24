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
});
