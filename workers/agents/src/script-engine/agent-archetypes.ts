/**
 * Agent archetype presets (AVOS plan step 5) — an OPT-IN validation layer for CUSTOM agent
 * creation (agent-templates.ts's customAgentToConfig), not a runtime override of every agent's
 * config.
 *
 * Why opt-in, and why not a runtime prune inside ScriptToolSurface/NaelaoAgentDO: the platform's
 * REAL capability firewall already exists and is already enforced structurally — every agent
 * definition (a fixed AGENT_TEMPLATES entry, a Launchpad core agent, a Space Assistant profile)
 * carries its OWN curated `config.scripts.prebuilt` list, and ScriptToolSurface builds its
 * operation map ONLY from that list (an op not on it is not merely gated, it does not exist to
 * call — see tool-surface.ts's own header). A SECOND, runtime archetype-based pruning layer that
 * silently overrides an agent's own declared config would be exactly the split-brain this
 * codebase's own convention repeatedly warns against (two authorities, one silently wins) — and
 * every FIXED template (AGENT_TEMPLATES) is already Naelao-curated and pre-vetted; there is
 * nothing to firewall there that its own script list doesn't already firewall.
 *
 * The REAL gap: `customAgentToConfig`'s `CustomAgentInput.prebuilt_scripts` accepts ANY string
 * list from an END USER with zero validation — a "Customer Support" custom agent could be handed
 * `code-exec`/`local-machine`/`workspace-admin` with no guardrail at all. THIS is where a
 * capability firewall earns its keep: at the moment a human is granting capabilities to a NEW,
 * user-authored agent, not as a runtime interceptor second-guessing every agent that already
 * exists. See createCustomAgent (workers/agents/src/index.ts) for the one call site.
 */

export type AgentArchetypeRole = "dev_operator" | "growth_operator" | "customer_support" | "architect_delegate";

export interface ArchetypePreset {
  role: AgentArchetypeRole;
  label: string;
  description: string;
  /** Every prebuilt script name a custom agent of this archetype may request. An allowlist
   *  (fail-closed on an unrecognized/new script), not a denylist — a newly-added prebuilt script
   *  is unavailable to every archetype until someone consciously classifies it, same posture as
   *  assistant-access.ts's own READ_SAFE_PREBUILT_OPS. r2-workspace/memory/notifications are
   *  always included by customAgentToConfig itself regardless of archetype (the universal
   *  baseline every agent gets — filesystem, memory, notifications), so they're omitted here.
   */
  allowedScripts: readonly string[];
}

export const ARCHETYPE_PRESETS: Record<AgentArchetypeRole, ArchetypePreset> = {
  dev_operator: {
    role: "dev_operator",
    label: "Dev / Operator",
    description: "Writes and runs code, reaches external tools over MCP — the highest-capability archetype.",
    allowedScripts: [
      "code-exec", "mcp-connector", "web-search", "knowledge-base", "workspace",
      "conversation", "project-journal", "artifacts", "schedule", "tasks", "sub-agent",
    ],
  },
  growth_operator: {
    role: "growth_operator",
    label: "Growth / Sales",
    description: "Qualifies leads, drafts outreach, reads the business's own revenue data — never moves money or runs code.",
    allowedScripts: [
      "web-search", "knowledge-base", "notifications", "business-email", "conversation",
      "project-journal", "commerce", "revenue-tracker", "schedule", "tasks",
    ],
  },
  customer_support: {
    role: "customer_support",
    label: "Customer Support",
    description: "Answers from the knowledge base and hands off what it can't verify — the narrowest archetype: no code execution, no filesystem beyond the universal baseline, no local-machine access.",
    allowedScripts: [
      "knowledge-base", "conversation", "notifications", "business-email", "project-journal",
    ],
  },
  architect_delegate: {
    role: "architect_delegate",
    label: "Architect / Delegate",
    description: "Plans and delegates — spawns sub-agents and coordinates project threads/tasks, but never executes code or reaches the outside world directly itself.",
    allowedScripts: [
      "sub-agent", "project-coordination", "tasks", "project-journal", "conversation",
      "schedule", "knowledge-base",
    ],
  },
};

export function isKnownArchetype(value: unknown): value is AgentArchetypeRole {
  return typeof value === "string" && value in ARCHETYPE_PRESETS;
}

/**
 * Clamp a custom agent's requested prebuilt-script list to what its chosen archetype allows.
 * Returns BOTH the allowed subset and what was rejected — a silent narrowing with no signal back
 * to the person configuring the agent would just move the confusion from "an unrestricted agent"
 * to "an agent that mysteriously can't do what it was configured to do."
 */
export function clampScriptsToArchetype(
  archetype: AgentArchetypeRole,
  requestedScripts: string[]
): { allowed: string[]; rejected: string[] } {
  const preset = ARCHETYPE_PRESETS[archetype];
  const allowedSet = new Set(preset.allowedScripts);
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const script of requestedScripts) {
    if (allowedSet.has(script)) allowed.push(script);
    else rejected.push(script);
  }
  return { allowed, rejected };
}
