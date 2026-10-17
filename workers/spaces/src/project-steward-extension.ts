import type { ExtensionManifest } from "@naelao/agent-sdk";

/** Platform-owned, non-executable extension identity for the per-Space Project Steward. The
 * scheduled host service supplies its only capability through a typed internal summary grant. */
export const PROJECT_STEWARD_EXTENSION_ID = "ext_project_steward";
export const PROJECT_STEWARD_EXTENSION_MANIFEST: ExtensionManifest = {
  id: PROJECT_STEWARD_EXTENSION_ID,
  type: "extension",
  declaredPermissions: [],
  capabilityRequirements: ["space.project_steward.read_summary"],
  gadgets: [],
  daemons: [],
  commands: [],
};
