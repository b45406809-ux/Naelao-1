import type { SpaceBlueprint } from "./types.js";
import { validateAssistantChannelDefaults, validateAssistantChannelPatch } from "./assistant-channels.js";
import { PROJECT_KINDS } from "./canvas-runtime.js";

/** Validate and detach a blueprint before it crosses a trust boundary. */
export function instantiateBlueprint(blueprint: SpaceBlueprint, targetSpaceId: string): SpaceBlueprint {
  if (!targetSpaceId.trim()) throw new Error("targetSpaceId is required");
  if (blueprint.schemaVersion !== "2.0") throw new Error("Unsupported blueprint schemaVersion");
  if (!blueprint.id || !Array.isArray(blueprint.projects)) throw new Error("Invalid blueprint");
  const copy = structuredClone(blueprint);
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
    if (project.configuration?.assistantChannels !== undefined) project.configuration.assistantChannels = validateAssistantChannelPatch(project.configuration.assistantChannels);
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
