// Naelao Agent Templates — curated, vertically-focused presets for a PROJECT's own agent.
//
// Why this exists: every project agent on the platform has been the exact same generic
// "Naelao Agent" identity with the same broad tool list, differing only in whatever ad-hoc
// instructions a builder typed into its system prompt by hand. A project that genuinely wants a
// customer-support specialist (narrow tool list, de-escalation instincts, escalate-don't-guess
// autonomy) had no faster path than authoring all four R2 config files from scratch. This is the
// same "curated code catalogue, not yet builder-authorable" pattern already established for
// LAUNCHPAD_TEMPLATES/CONNECTOR_CATALOGUE/CONTAINER_CATALOGUE — a real, distinct configuration
// per template, not a cosmetic label on the same generic agent.
//
// "Execution tier" is deliberately NOT a separate enforced field here — the execution ladder
// (script-engine/execution-ladder.ts) auto-routes per command. Every Naelao agent receives the
// universal Bash implementation; the manifest and runtime ceiling decide which tiers it can use.

import type { AgentConfig, ScriptsConfig } from "./script-engine/agent-config.js";
import { UNIVERSAL_AGENT_BASELINE_PREBUILTS } from "./script-engine/agent-topology.js";

const BASE_AGENTS_MD = `# Behavioral Rules
- Always observe the environment before acting.
- Always check the script library (script.find) before reasoning from scratch.
- Always attempt distillation after a successful live run.
- Never skip the fingerprint check, even when confident the environment is unchanged.
- If a script has been patched more than five times, flag it for review instead of patching again.`;

/** Step 17: a CUSTOM agent built from user-supplied config rather than a fixed template — the
 *  user picks the instructions, the tool (prebuilt-script) list, and the tone. The universal
 *  baseline (r2-workspace/memory/notifications) is always included, exactly as a template's is,
 *  so a custom agent can never end up with no filesystem/memory at all. `approval_mode` and
 *  `auto_approved_actions` are seeded separately by the caller (same as a template). */
export interface CustomAgentInput {
  name: string;
  description?: string;
  instructions: string;
  system_prompt?: string;
  prebuilt_scripts: string[];
  skills?: string[];
  connectors?: string[];
}
export function customAgentToConfig(input: CustomAgentInput): AgentConfig {
  const prebuilt = new Set<string>(["r2-workspace", "memory", "notifications", ...UNIVERSAL_AGENT_BASELINE_PREBUILTS, ...input.prebuilt_scripts]);
  const scripts: ScriptsConfig = {
    prebuilt: [...prebuilt],
    agent_scripts: "auto",
    startup_observe: "observe_filesystem",
  };
  return {
    agentsMd: `# Agent Identity
Custom agent: ${input.name}
${input.description ? `Role: ${input.description}\n` : ""}
${input.instructions}
${input.connectors?.length ? `\nConfigured connector scope: ${input.connectors.join(", ")}. Use mcp-connector for these services and do not assume an unselected service is available.\n` : ""}

${BASE_AGENTS_MD}`,
    systemPrompt: input.system_prompt?.trim() || `You are ${input.name}, a specialist agent. ${input.description ?? ""}`.trim(),
    scripts,
    skills: { skills: (input.skills ?? []).map((name) => ({ name, tier: "space" as const })) },
  };
}
