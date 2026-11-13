import { describe, expect, it } from "vitest";
import { validateBlueprintSetupSchema, validateBlueprintSetupValues } from "./blueprint-setup-fields.js";
import type { SpaceBlueprint } from "./types.js";

const blueprint: SpaceBlueprint = {
  id: "support-bot", schemaVersion: "2.0", setupSchemaVersion: 1, metadata: {}, templateCategory: "support",
  requiredExtensions: [], requiredCredentials: [], projects: [{
    id: "support", name: "Support", kind: "DualPane", templateMode: "cowork_studio", viewports: {},
    systemPrompt: "", initialTasks: [], starterFiles: [], setupFields: [
      { id: "greeting", type: "text", label: "Greeting", required: true, minLength: 3, maxLength: 80 },
      { id: "hours", type: "number", label: "Business hours", minimum: 1, maximum: 24, integer: true, defaultValue: 8 },
      { id: "enabled", type: "boolean", label: "Enable weekends", defaultValue: false },
      { id: "language", type: "select", label: "Language", options: [{ value: "en", label: "English" }, { value: "fr", label: "French" }] },
    ],
  }],
};

describe("versioned Space Template setup fields", () => {
  it("validates and clones a bounded schema, applies defaults and validates values", () => {
    expect(validateBlueprintSetupSchema(blueprint)).toEqual([{ project_id: "support", project_name: "Support", fields: blueprint.projects[0]!.setupFields }]);
    expect(validateBlueprintSetupValues(blueprint, { support: { greeting: "Hello", language: "fr" } })).toEqual({
      support: { greeting: "Hello", hours: 8, enabled: false, language: "fr" },
    });
  });

  it("requires the setup contract version and a stable project id", () => {
    expect(() => validateBlueprintSetupSchema({ ...blueprint, setupSchemaVersion: undefined })).toThrow("setupSchemaVersion 1 is required");
    expect(() => validateBlueprintSetupSchema({ ...blueprint, projects: [{ ...blueprint.projects[0]!, id: undefined }] })).toThrow("unique stable project id");
  });

  it("rejects unsupported logic, secret-like fields, invalid options and duplicate ids", () => {
    const project = blueprint.projects[0]!;
    expect(() => validateBlueprintSetupSchema({ ...blueprint, projects: [{ ...project, setupFields: [{ ...project.setupFields![0]!, visibleWhen: "true" } as never] }] })).toThrow("unsupported property");
    expect(() => validateBlueprintSetupSchema({ ...blueprint, projects: [{ ...project, setupFields: [{ id: "api_key", type: "text", label: "Provider details" } as never] }] })).toThrow("cannot request provider credentials");
    expect(() => validateBlueprintSetupSchema({ ...blueprint, projects: [{ ...project, setupFields: [project.setupFields![0]!, project.setupFields![0]!] }] })).toThrow("Duplicate setup field id");
  });

  it("rejects missing required fields, unknown fields and invalid typed values", () => {
    expect(() => validateBlueprintSetupValues(blueprint, {})).toThrow("Required setup value missing");
    expect(() => validateBlueprintSetupValues(blueprint, { support: { greeting: "OK", extra: "x" } })).toThrow("Unknown setup field");
    expect(() => validateBlueprintSetupValues(blueprint, { support: { greeting: "OK", hours: 8.5 } })).toThrow("Invalid setup value");
    expect(() => validateBlueprintSetupValues(blueprint, { support: { greeting: "OK", language: "de" } })).toThrow("Invalid setup value");
    expect(() => validateBlueprintSetupValues(blueprint, { support: { greeting: "OK" }, other: { field: true } })).toThrow("Unknown setup project");
  });
});
