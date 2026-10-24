/** Generic role presets used only to bound tools a user-configured worker may request.
 * Workers all run the Naelao agent runtime; these labels are configuration hints, not separate
 * agent products or business personas. The planner may further reduce this allowlist per task. */

export type AgentArchetypeRole = "general" | "developer" | "researcher" | "coordinator";

export interface ArchetypePreset {
  role: AgentArchetypeRole;
  label: string;
  description: string;
  allowedScripts: readonly string[];
}

const COMMON = ["conversation", "knowledge-base", "notifications", "memory", "r2-workspace", "file-manager", "document-processing", "mcp-connector"];

export const ARCHETYPE_PRESETS: Record<AgentArchetypeRole, ArchetypePreset> = {
  general: { role: "general", label: "General", description: "A configurable Naelao worker with task-specific access.", allowedScripts: [...COMMON, "web-search", "artifacts", "schedule", "tasks", "sub-agent"] },
  developer: { role: "developer", label: "Developer", description: "Works with code and authorized project files.", allowedScripts: [...COMMON, "code-exec", "workspace", "workspace-admin", "runtime-discovery", "artifacts", "tasks", "project-journal"] },
  researcher: { role: "researcher", label: "Researcher", description: "Finds and synthesizes information from authorized sources.", allowedScripts: [...COMMON, "web-search", "wiki", "fabric", "artifacts", "project-journal"] },
  coordinator: { role: "coordinator", label: "Coordinator", description: "Plans and coordinates project tasks using authorized tools.", allowedScripts: [...COMMON, "workspace-admin", "project-coordination", "project-journal", "tasks", "schedule", "sub-agent"] },
};

export function isKnownArchetype(value: unknown): value is AgentArchetypeRole {
  return typeof value === "string" && value in ARCHETYPE_PRESETS;
}

export function clampScriptsToArchetype(archetype: AgentArchetypeRole, requestedScripts: string[]): { allowed: string[]; rejected: string[] } {
  const allowedSet = new Set(ARCHETYPE_PRESETS[archetype].allowedScripts);
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const script of requestedScripts) (allowedSet.has(script) ? allowed : rejected).push(script);
  return { allowed, rejected };
}
