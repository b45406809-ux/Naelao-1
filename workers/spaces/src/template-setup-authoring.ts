import { validateBlueprintSetupSchema, type BlueprintSetupField, type SpaceBlueprint } from "@naelao/agent-sdk";

/** Attach one author's visual setup form to the exact exported project and validate it with the same
 * SDK contract used by activation. Caller-provided schemas remain data; no executable form logic is accepted. */
export function attachBlueprintSetupFields(
  source: SpaceBlueprint,
  input: { projectId: unknown; schemaVersion: unknown; fields: unknown },
): SpaceBlueprint {
  if (typeof input.projectId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.projectId))
    throw new Error("blueprint_setup_project_invalid");
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) throw new Error("blueprint_setup_schema_version_invalid");
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 32)
    throw new Error("blueprint_setup_fields_invalid");

  const blueprint = structuredClone(source);
  const project = blueprint.projects.find(candidate => candidate.id === input.projectId);
  if (!project) throw new Error("blueprint_setup_project_not_exported");
  project.setupFields = input.fields as BlueprintSetupField[];
  blueprint.setupSchemaVersion = input.schemaVersion;
  const groups = validateBlueprintSetupSchema(blueprint);
  if (groups.length !== 1 || groups[0]?.project_id !== input.projectId)
    throw new Error("blueprint_setup_schema_invalid");
  return blueprint;
}
