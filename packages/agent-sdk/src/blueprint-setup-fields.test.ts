import { describe, expect, it } from "vitest";
import { isBlueprintSetupFieldVisible, resolveBlueprintSetupFieldHelpText, resolveBlueprintSetupFieldLabel, resolveBlueprintSetupOptionLabel,
  migrateBlueprintSetupValues, validateBlueprintSetupGroups, validateBlueprintSetupSchema, validateBlueprintSetupValues,
  validateBlueprintSetupValuesForSchema } from "./blueprint-setup-fields.js";
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

  it("validates incomplete setup drafts without requiring fields the owner has not filled yet", () => {
    const groups = validateBlueprintSetupGroups(validateBlueprintSetupSchema(blueprint));
    expect(validateBlueprintSetupValuesForSchema(groups, { support: {} }, { allowIncomplete: true })).toEqual({
      support: { hours: 8, enabled: false },
    });
    expect(() => validateBlueprintSetupValuesForSchema(groups, { support: { greeting: "x" } }, { allowIncomplete: true })).toThrow("Invalid setup value");
  });

  it("supports signed v2 equality conditions and locale fallback without executable logic", () => {
    const localized: SpaceBlueprint = { ...blueprint, setupSchemaVersion: 2, projects: [{ ...blueprint.projects[0]!, setupFields: [
      { id: "channel", type: "select", label: "Channel", defaultValue: "web",
        localization: { label: { en: "Channel", fr: "Canal" }, optionLabels: { web: { fr: "Web" }, whatsapp: { fr: "WhatsApp" } } },
        options: [{ value: "web", label: "Website" }, { value: "whatsapp", label: "WhatsApp" }] },
      { id: "phone_number", type: "text", label: "Phone number", required: true, minLength: 4, maxLength: 30,
        visibleWhen: { fieldId: "channel", equals: "whatsapp" }, localization: { label: { fr: "Numéro de téléphone" }, helpText: { fr: "Utilisé pour les messages." } } },
    ] }] };
    const groups = validateBlueprintSetupSchema(localized);
    const [channel, phone] = groups[0]!.fields;
    expect(resolveBlueprintSetupFieldLabel(channel!, "fr-CA")).toBe("Canal");
    expect(resolveBlueprintSetupOptionLabel(channel as Extract<typeof channel, { type: "select" }>, "web", "fr-FR")).toBe("Web");
    expect(resolveBlueprintSetupFieldHelpText(phone!, "fr")).toBe("Utilisé pour les messages.");
    expect(isBlueprintSetupFieldVisible(groups[0]!.fields, phone!, { channel: "web" })).toBe(false);
    expect(validateBlueprintSetupValues(localized, { support: { channel: "web", phone_number: "ignored while hidden" } })).toEqual({ support: { channel: "web" } });
    expect(() => validateBlueprintSetupValues(localized, { support: { channel: "whatsapp" } })).toThrow("Required setup value missing");
    expect(validateBlueprintSetupValues(localized, { support: { channel: "whatsapp", phone_number: "+263 77" } })).toMatchObject({ support: { phone_number: "+263 77" } });
    expect(() => validateBlueprintSetupSchema({ ...localized, setupSchemaVersion: 1 })).toThrow("unsupported property");
    expect(() => validateBlueprintSetupSchema({ ...localized, projects: [{ ...localized.projects[0]!, setupFields: [
      { id: "phone_number", type: "text", label: "Phone", visibleWhen: { fieldId: "later", equals: "x" } } as never,
      { id: "later", type: "text", label: "Later" },
    ] }] })).toThrow("earlier field");
    expect(() => validateBlueprintSetupSchema({ ...localized, projects: [{ ...localized.projects[0]!, setupFields: [
      { id: "phone_number", type: "text", label: "Phone", localization: { label: { fr: "Identifiant secret" } } },
    ] }] })).toThrow("cannot request provider credentials");
  });

  it("caps the complete localized schema byte size", () => {
    const locales = Object.fromEntries(["en", "fr", "de", "es", "it", "pt", "nl", "sv", "no", "fi", "da", "pl"].map(locale => [locale, "x".repeat(80)]));
    const options = Array.from({ length: 30 }, (_, index) => ({ value: `option${index}`, label: `Option ${index}` }));
    const optionLabels = Object.fromEntries(options.map(option => [option.value, locales]));
    const fields = Array.from({ length: 3 }, (_, index) => ({ id: `select_${index}`, type: "select" as const, label: "Choice",
      options, localization: { optionLabels } }));
    expect(() => validateBlueprintSetupSchema({ ...blueprint, setupSchemaVersion: 2,
      projects: [{ ...blueprint.projects[0]!, setupFields: fields }] })).toThrow("exceeds the byte limit");
  });

  it("revalidates persisted schema groups and updates one project without dropping others", () => {
    const groups = validateBlueprintSetupGroups(validateBlueprintSetupSchema(blueprint));
    expect(validateBlueprintSetupValuesForSchema(groups, { support: { greeting: "Hello", language: "fr" } })).toMatchObject({
      support: { greeting: "Hello", hours: 8, enabled: false, language: "fr" },
    });
    expect(() => validateBlueprintSetupGroups([{ project_id: "support", project_name: "Support", fields: [], executable: "run()" }])).toThrow("unsupported property");
  });

  it("previews a signed declarative setup migration and reports fields needing owner input", () => {
    const target: SpaceBlueprint = {
      ...blueprint,
      setupSchemaVersion: 2,
      setupMigrations: [{
        fromArtifactSha256: "a".repeat(64),
        fromSchemaSha256: "b".repeat(64),
        operations: [
          { kind: "rename", fromProjectId: "support", fromFieldId: "greeting", toProjectId: "support", toFieldId: "welcome" },
          { kind: "drop", projectId: "support", fieldId: "enabled" },
          { kind: "drop", projectId: "support", fieldId: "language" },
          { kind: "default", projectId: "support", fieldId: "timezone", value: "UTC" },
        ],
      }],
      projects: [{ ...blueprint.projects[0]!, setupFields: [
        { id: "welcome", type: "text", label: "Welcome", required: true, minLength: 3, maxLength: 80 },
        { id: "hours", type: "number", label: "Business hours", minimum: 1, maximum: 24, integer: true, defaultValue: 8 },
        { id: "timezone", type: "select", label: "Timezone", required: true, options: [{ value: "UTC", label: "UTC" }, { value: "PST", label: "Pacific" }] },
        { id: "region", type: "text", label: "Support region", required: true, minLength: 2, maxLength: 32 },
      ] }],
    };
    const oldGroups = validateBlueprintSetupSchema(blueprint);
    const newGroups = validateBlueprintSetupSchema(target);
    const migration = target.setupMigrations![0]!;
    const source = { artifactSha256: migration.fromArtifactSha256, schemaSha256: migration.fromSchemaSha256 };
    const preview = migrateBlueprintSetupValues(oldGroups, newGroups,
      { support: { greeting: "Hello", hours: 12, enabled: true, language: "fr" } }, migration, source);
    expect(preview).toEqual({
      values: { support: { welcome: "Hello", hours: 12, timezone: "UTC" } },
      missingRequired: [{ project_id: "support", field_id: "region", label: "Support region" }],
    });
    expect(migrateBlueprintSetupValues(oldGroups, newGroups,
      { support: { greeting: "Hello", hours: 12, enabled: true, language: "fr" } }, migration,
      source, { support: { region: "southern-africa" } }).missingRequired).toEqual([]);
    expect(() => migrateBlueprintSetupValues(oldGroups, newGroups,
      { support: { greeting: "Hello", hours: 12, enabled: true, language: "fr" } }, migration,
      { ...source, artifactSha256: "c".repeat(64) })).toThrow("does not match the installed artifact");
  });

  it("rejects implicit loss, incompatible renames, invalid defaults and executable migration data", () => {
    const oldGroups = validateBlueprintSetupSchema(blueprint);
    const target = { ...blueprint, projects: [{ ...blueprint.projects[0]!, setupFields: [
      { id: "greeting", type: "number", label: "Greeting number" },
    ] }] } as SpaceBlueprint;
    const newGroups = validateBlueprintSetupSchema(target);
    const base = { fromArtifactSha256: "a".repeat(64), fromSchemaSha256: "b".repeat(64), operations: [] };
    const source = { artifactSha256: base.fromArtifactSha256, schemaSha256: base.fromSchemaSha256 };
    expect(() => migrateBlueprintSetupValues(oldGroups, newGroups,
      { support: { greeting: "Hello", hours: 8, enabled: false, language: "en" } }, base, source)).toThrow("explicit migration");
    expect(() => migrateBlueprintSetupValues(oldGroups, newGroups,
      { support: { greeting: "Hello", hours: 8, enabled: false, language: "en" } }, { ...base, operations: [
        { kind: "rename", fromProjectId: "support", fromFieldId: "greeting", toProjectId: "support", toFieldId: "greeting" },
      ] }, source)).toThrow("incompatible");
    expect(() => validateBlueprintSetupSchema({ ...blueprint, setupMigrations: [{ ...base, operations: [
      { kind: "default", projectId: "support", fieldId: "language", value: "unknown" },
    ] }] })).toThrow("Invalid setup value");
    expect(() => validateBlueprintSetupSchema({ ...blueprint, setupMigrations: [{ ...base, executable: "run()", operations: [] } as never] })).toThrow("unsupported property");
  });
});
