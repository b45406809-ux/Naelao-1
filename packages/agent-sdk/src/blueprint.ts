import type { SpaceBlueprint } from "./types.js";
import { validateAssistantChannelDefaults, validateAssistantChannelPatch } from "./assistant-channels.js";
import { PROJECT_KINDS } from "./canvas-runtime.js";

/** Validate and detach a blueprint before it crosses a trust boundary. */
export function instantiateBlueprint(blueprint: SpaceBlueprint, targetSpaceId: string): SpaceBlueprint {
  if (!targetSpaceId.trim()) throw new Error("targetSpaceId is required");
  if (blueprint.schemaVersion !== "2.0") throw new Error("Unsupported blueprint schemaVersion");
  if (!blueprint.id || !Array.isArray(blueprint.projects)) throw new Error("Invalid blueprint");
  const copy = structuredClone(blueprint);
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
