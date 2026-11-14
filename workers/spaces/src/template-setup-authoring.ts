import { validateAssistantChannelDefaults, validateBlueprintSetupSchema, type AssistantChannelTemplateDefaults, type BlueprintSetupField, type SpaceBlueprint } from "@naelao/agent-sdk";

/** Attach one author's visual setup form to the exact exported project and validate it with the same
 * SDK contract used by activation. Caller-provided schemas remain data; no executable form logic is accepted. */
export function attachBlueprintSetupFields(
  source: SpaceBlueprint,
  input: { projectId: unknown; schemaVersion: unknown; fields: unknown },
): SpaceBlueprint {
  if (typeof input.projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.projectId))
    throw new Error("blueprint_setup_project_invalid");
  return attachBlueprintSetupFieldGroups(source, { schemaVersion: input.schemaVersion, fieldsByProject: { [input.projectId]: input.fields } });
}

/** Attach bounded setup groups to exact exported projects and run the shared signed-schema validator. */
export function attachBlueprintSetupFieldGroups(
  source: SpaceBlueprint,
  input: { schemaVersion: unknown; fieldsByProject: unknown },
): SpaceBlueprint {
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) throw new Error("blueprint_setup_schema_version_invalid");
  if (!input.fieldsByProject || typeof input.fieldsByProject !== "object" || Array.isArray(input.fieldsByProject))
    throw new Error("blueprint_setup_groups_invalid");
  const entries = Object.entries(input.fieldsByProject as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 64) throw new Error("blueprint_setup_groups_invalid");

  const blueprint = structuredClone(source);
  for (const [projectId, fields] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) throw new Error("blueprint_setup_project_invalid");
    if (!Array.isArray(fields) || fields.length < 1 || fields.length > 32) throw new Error("blueprint_setup_fields_invalid");
    const project = blueprint.projects.find(candidate => candidate.id === projectId);
    if (!project) throw new Error("blueprint_setup_project_not_exported");
    project.setupFields = fields as BlueprintSetupField[];
  }
  blueprint.setupSchemaVersion = input.schemaVersion;
  const groups = validateBlueprintSetupSchema(blueprint);
  if (entries.some(([projectId]) => !groups.some(group => group.project_id === projectId))) throw new Error("blueprint_setup_schema_invalid");
  return blueprint;
}

/** Template channel declarations are availability preferences only. Account selection,
 * provisioning and spend remain per installation and are never accepted from this authoring path. */
export function attachBlueprintAssistantChannelDefaults(
  source: SpaceBlueprint,
  input: unknown,
): SpaceBlueprint {
  const checked = validateAssistantChannelDefaults(input);
  if (checked.emailProvisioning !== undefined) throw new Error("blueprint_assistant_channel_provisioning_not_authorable");
  const blueprint = structuredClone(source);
  blueprint.assistantChannels = checked as Pick<AssistantChannelTemplateDefaults, "spaceAssistant" | "projectAssistants">;
  return blueprint;
}
