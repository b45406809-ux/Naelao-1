import type { SpaceBlueprint } from "./types.js";

/** Validate and detach a blueprint before it crosses a trust boundary. */
export function instantiateBlueprint(blueprint: SpaceBlueprint, targetSpaceId: string): SpaceBlueprint {
  if (!targetSpaceId.trim()) throw new Error("targetSpaceId is required");
  if (blueprint.schemaVersion !== "2.0") throw new Error("Unsupported blueprint schemaVersion");
  if (!blueprint.id || !Array.isArray(blueprint.projects)) throw new Error("Invalid blueprint");
  const copy = structuredClone(blueprint);
  for (const project of copy.projects) {
    if (!project.name.trim() || !project.kind.trim()) throw new Error("Every project requires name and kind");
    for (const file of project.starterFiles) {
      if(file.path.startsWith("/") && !file.path.startsWith("/workspace/")) throw new Error(`Unsafe starter file path: ${file.path}`);
      file.path = file.path.replace(/^\/workspace\//, "").replace(/^\/+/, "");
      if (!file.path || file.path.split("/").includes("..")) throw new Error(`Unsafe starter file path: ${file.path}`);
    }
  }
  copy.metadata.targetSpaceId = targetSpaceId;
  return copy;
}
