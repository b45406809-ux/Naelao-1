import type { AgentManifest } from "../manifest.js";

/**
 * Custom business — the "describe your own business" path. A minimal manifest: no
 * curated scripts (the engine re-derives everything live at Level 4) and a higher
 * cost multiplier because that reasoning is the expensive path. As the agent proves
 * scripts, distillation grows its library — Voyager-style — and proven scripts can be
 * promoted to the shared registry so the custom path gets cheaper over time.
 */
export const CUSTOM_MANIFEST: AgentManifest = {
  id: "custom",
  kind: "niche",
  name: "Custom business",
  description: "A business defined entirely by the user's free-text goal; the agent figures out how to build and run it.",
  cost_multiplier: 3,
  free_tier_eligible: false,
  skills: ["observe-first", "verify-landed", "improve-tool"],
  capabilities: ["build_tool", "observe", "log_cycle_outcome"],
  instructions:
    "You run a custom business defined by the user's goal. There is no curated playbook — " +
    "reason from first principles each cycle, ground every decision in real observed state, " +
    "verify actions actually landed before recording success, and use the Tier-5 container to " +
    "build and TEST any tool before it ships. You are bounded by the platform safety floor.",
  seed_scripts: [],
};
