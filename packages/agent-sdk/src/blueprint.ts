import { validateTemplateRuntimes } from "./execution-environments.js";
import type { BlueprintExtensionActionRequirement, BlueprintExtensionKnowledgeRequirement, BlueprintExtensionRequirements, GadgetScope, PermissionAction, SpaceBlueprint } from "./types.js";
import { validateAssistantChannelDefaults, validateAssistantChannelPatch, validateAssistantEmailProvisioning } from "./assistant-channels.js";
import { PROJECT_KINDS } from "./canvas-runtime.js";
import { validateBlueprintSetupSchema } from "./blueprint-setup-fields.js";
import { validateSpaceCoordinationSingletonKeys } from "./space-coordination.js";

const BLUEPRINT_EXTENSION_SCOPES = new Set<GadgetScope>(["USER_PRIVATE", "SPACE_WIDE", "PROJECT_BOUND", "PROJECT_SHARED", "PROJECT_USER", "SPACE_SHARED", "SPACE_USER"]);
const BLUEPRINT_PERMISSION_ACTIONS = new Set<PermissionAction>(["read", "write", "execute", "network", "admin"]);

/** Validate signed review references against the blueprint's immutable dependency list. */
export function validateBlueprintExtensionRequirements(
  value: unknown,
  requiredExtensions: readonly string[] = [],
): BlueprintExtensionRequirements {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid extension requirements");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => key !== "knowledge" && key !== "actions")) throw new Error("Invalid extension requirements");
  const dependencies = new Set(requiredExtensions);
  const knowledge = raw.knowledge;
  const actions = raw.actions;
  if (knowledge !== undefined && (!Array.isArray(knowledge) || knowledge.length > 128)) throw new Error("Invalid knowledge requirements");
  if (actions !== undefined && (!Array.isArray(actions) || actions.length > 128)) throw new Error("Invalid action requirements");
  const seenKnowledge = new Set<string>();
  const canonicalKnowledge: BlueprintExtensionKnowledgeRequirement[] | undefined = (knowledge as unknown[] | undefined)?.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid knowledge requirement");
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).some(key => !["extensionId", "knowledgeId", "purpose", "access", "required"].includes(key))) throw new Error("Invalid knowledge requirement");
    const { extensionId, knowledgeId, purpose, access, required } = entry;
    if (typeof extensionId !== "string" || !/^ext_[a-z][a-z0-9_]{0,59}$/.test(extensionId) || !dependencies.has(extensionId)
      || typeof knowledgeId !== "string" || !/^[a-z][a-z0-9_-]{2,63}$/.test(knowledgeId)
      || typeof purpose !== "string" || !purpose.trim() || purpose.length > 240
      || (access !== "member_only" && access !== "owner_published_external") || typeof required !== "boolean")
      throw new Error("Invalid knowledge requirement");
    const key = `${extensionId}:${knowledgeId}`;
    if (seenKnowledge.has(key)) throw new Error("Duplicate knowledge requirement");
    seenKnowledge.add(key);
    return { extensionId, knowledgeId, purpose: purpose.trim(), access: access as BlueprintExtensionKnowledgeRequirement["access"], required };
  });
  const seenActions = new Set<string>();
  const canonicalActions: BlueprintExtensionActionRequirement[] | undefined = (actions as unknown[] | undefined)?.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid action requirement");
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).some(key => !["extensionId", "primitiveId", "scope", "resource", "action", "purpose", "required"].includes(key))) throw new Error("Invalid action requirement");
    const { extensionId, primitiveId, scope, resource, action, purpose, required } = entry;
    if (typeof extensionId !== "string" || !/^ext_[a-z][a-z0-9_]{0,59}$/.test(extensionId) || !dependencies.has(extensionId)
      || typeof primitiveId !== "string" || !/^[a-z][a-z0-9._-]{1,63}$/.test(primitiveId)
      || typeof scope !== "string" || !BLUEPRINT_EXTENSION_SCOPES.has(scope as GadgetScope)
      || typeof resource !== "string" || !resource.trim() || resource.length > 160 || /[\u0000-\u001f\u007f]/.test(resource)
      || typeof action !== "string" || !BLUEPRINT_PERMISSION_ACTIONS.has(action as PermissionAction)
      || typeof purpose !== "string" || !purpose.trim() || purpose.length > 240 || typeof required !== "boolean")
      throw new Error("Invalid action requirement");
    const key = `${extensionId}:${primitiveId}:${scope}:${resource}:${action}`;
    if (seenActions.has(key)) throw new Error("Duplicate action requirement");
    seenActions.add(key);
    return { extensionId, primitiveId, scope: scope as GadgetScope, resource: resource.trim(), action: action as PermissionAction, purpose: purpose.trim(), required };
  });
  if ((!canonicalKnowledge || canonicalKnowledge.length === 0) && (!canonicalActions || canonicalActions.length === 0))
    throw new Error("Empty extension requirements");
  return {
    ...(canonicalKnowledge ? { knowledge: canonicalKnowledge } : {}),
    ...(canonicalActions ? { actions: canonicalActions } : {}),
  };
}

/** Validate and detach a blueprint before it crosses a trust boundary. */
export function instantiateBlueprint(blueprint: SpaceBlueprint, targetSpaceId: string): SpaceBlueprint {
  if (!targetSpaceId.trim()) throw new Error("targetSpaceId is required");
  if (blueprint.schemaVersion !== "2.0") throw new Error("Unsupported blueprint schemaVersion");
  if (!blueprint.id || !Array.isArray(blueprint.projects)) throw new Error("Invalid blueprint");
  const copy = structuredClone(blueprint);
  validateBlueprintSetupSchema(copy);
  if (copy.extensionRequirements !== undefined)
    copy.extensionRequirements = validateBlueprintExtensionRequirements(copy.extensionRequirements, copy.requiredExtensions ?? []);
  if (copy.coordinationDefaults !== undefined) {
    const defaults = copy.coordinationDefaults as unknown;
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)
      || Object.keys(defaults).some(key => key !== "memberFactsEnabled" && key !== "singletonCapabilityKeys")) {
      throw new Error("Invalid coordination defaults");
    }
    const value = defaults as { memberFactsEnabled?: unknown; singletonCapabilityKeys?: unknown };
    if (value.memberFactsEnabled !== undefined && typeof value.memberFactsEnabled !== "boolean") throw new Error("Invalid coordination defaults");
    let singletonCapabilityKeys: string[] | undefined;
    if (value.singletonCapabilityKeys !== undefined) {
      const parsed = validateSpaceCoordinationSingletonKeys(value.singletonCapabilityKeys);
      if (!parsed.ok || parsed.value.length === 0) throw new Error("Invalid coordination defaults");
      singletonCapabilityKeys = parsed.value;
    }
    if (value.memberFactsEnabled === undefined && singletonCapabilityKeys === undefined) throw new Error("Invalid coordination defaults");
    copy.coordinationDefaults = {
      ...(value.memberFactsEnabled !== undefined ? { memberFactsEnabled: value.memberFactsEnabled } : {}),
      ...(singletonCapabilityKeys ? { singletonCapabilityKeys } : {}),
    } as NonNullable<SpaceBlueprint["coordinationDefaults"]>;
  }
  if (copy.requiredExtensionVersions !== undefined) {
    if (!copy.requiredExtensionVersions || typeof copy.requiredExtensionVersions !== "object" || Array.isArray(copy.requiredExtensionVersions)) throw new Error("Invalid required extension versions");
    const dependencies = new Set(copy.requiredExtensions ?? []);
    for (const [extensionId, version] of Object.entries(copy.requiredExtensionVersions)) {
      if (!dependencies.has(extensionId) || typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid required extension version: ${extensionId}`);
    }
  }
  if (copy.requiredExtensionDigests !== undefined) {
    if (!copy.requiredExtensionDigests || typeof copy.requiredExtensionDigests !== "object" || Array.isArray(copy.requiredExtensionDigests)) throw new Error("Invalid required extension digests");
    const dependencies = new Set(copy.requiredExtensions ?? []);
    for (const [extensionId, digest] of Object.entries(copy.requiredExtensionDigests)) {
      if (!dependencies.has(extensionId) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid required extension digest: ${extensionId}`);
    }
  }
  if (copy.assistantChannels !== undefined) copy.assistantChannels = validateAssistantChannelDefaults(copy.assistantChannels);
  for (const project of copy.projects) {
    if (project.runtimeRequirements !== undefined) validateTemplateRuntimes(project.runtimeRequirements);
    if (project.configuration?.assistantChannels !== undefined) project.configuration.assistantChannels = validateAssistantChannelPatch(project.configuration.assistantChannels);
    if (project.configuration?.assistantEmailProvisioning !== undefined) project.configuration.assistantEmailProvisioning = validateAssistantEmailProvisioning(project.configuration.assistantEmailProvisioning);
    if (!project.name.trim() || !(PROJECT_KINDS as readonly string[]).includes(project.kind)) {
      throw new Error("Every project requires a name and one of the supported project kinds");
    }
    for (const file of project.starterFiles) {
      if(file.path.startsWith("/") && !file.path.startsWith("/workspace/")) throw new Error(`Unsafe starter file path: ${file.path}`);
      file.path = file.path.replace(/^\/workspace\//, "").replace(/^\/+/, "");
      if (!file.path || file.path.split("/").includes("..")) throw new Error(`Unsafe starter file path: ${file.path}`);
    }
  }
  copy.metadata.targetSpaceId = targetSpaceId;
  return copy;
}
