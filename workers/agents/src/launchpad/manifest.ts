/**
 * Launchpad agent manifests — the de-hardcoding layer.
 *
 * Per the original spec: "SpaceType differences live in config, agent definitions,
 * and manifests — never in DB tables." A niche (Whop Businesses), a custom business,
 * and a Space Assistant are NOT different code paths — they are the SAME script-first
 * engine loaded with a different **manifest**: a bundle of prebuilt skills, seed
 * scripts, instructions, and capabilities.
 *
 * This is the Voyager model (Wang et al. 2023): one agent, a growing library of
 * executable skills, where the manifest is the starting library and the engine
 * grows it via distillation (§04). An "assistant" is just an agent whose manifest
 * also grants channel capabilities (Slack/Discord/email) and a heartbeat — the
 * "glorified agent" the spec describes.
 *
 * Manifests are DATA. Adding a niche or an assistant = adding a manifest, not code.
 */

export type ManifestKind = "niche" | "assistant";

export interface ManifestScript {
  name: string;
  description: string;
  code: string;
  tier: 1 | 2 | 5;
  preconditions: string[];
}

export interface AgentManifest {
  id: string;
  kind: ManifestKind;
  name: string;
  description: string;
  /** Foundation instructions rendered into the agent's system prompt. */
  instructions: string;
  /** Skill ids (from whop/skills.ts) this bundle activates. */
  skills: string[];
  /** Prebuilt scripts seeded into a new agent's registry — the Voyager starting library. */
  seed_scripts: ManifestScript[];
  /** Host-action / tool capability names this bundle may use. */
  capabilities: string[];
  /** Assistants only: channel integrations that "glorify" the agent. */
  channels?: string[];
  /** Cost multiplier — custom / L4-heavy bundles cost more (charged near real cost). */
  cost_multiplier: number;
  /** Free-tier users may onboard with this manifest without a paid plan. */
  free_tier_eligible: boolean;
}

import { WHOP_MANIFEST } from "./templates/whop-businesses.js";
import { CUSTOM_MANIFEST } from "./templates/custom.js";
import { SUPPORT_ASSISTANT_MANIFEST } from "./templates/support-assistant.js";

// ── Capability kernel (appendix @3614922: "No Formal Capability Kernel — Space Types
// Risk Forking Into Separate Codebases"). A fixed vocabulary of capabilities a manifest
// may declare. Anything outside this set is rejected — manifests cannot invent powers.
export const CAPABILITY_KERNEL: ReadonlySet<string> = new Set([
  // Whop niche
  "observe_whop_snapshot", "post_community_update", "check_community_engagement",
  "check_revenue_delta", "draft_welcome_post", "update_product_visibility", "log_cycle_outcome",
  // general agent
  "observe", "build_tool", "search_knowledge",
  // assistant / channels
  "read_channel", "reply_in_channel", "escalate_to_human",
  // projects + collaboration (spec §27/§33)
  "create_project", "create_thread_in_project", "read_project_threads",
  // peer-agent configuration
  "configure_agent", "configure_llm_provider",
]);

// ── Base inheritance (appendix @3617022: "No Base/Standard Space Type or Manifest
// Inheritance — Every Manifest Re-declares Everything"). Every manifest inherits these
// foundational skills so they don't re-declare them.
export const BASE_SKILLS: readonly string[] = ["observe-first", "verify-landed"];

/** Validate a manifest against the capability kernel. Throws on an unknown capability. */
export function validateManifest(m: AgentManifest): void {
  for (const cap of m.capabilities) {
    if (!CAPABILITY_KERNEL.has(cap)) {
      throw new Error(`Manifest '${m.id}' declares unknown capability '${cap}' (not in the capability kernel)`);
    }
  }
}

const REGISTRY: Record<string, AgentManifest> = {
  "whop-businesses-v1": WHOP_MANIFEST,
  "whop-businesses": WHOP_MANIFEST,
  "custom": CUSTOM_MANIFEST,
  "support-assistant": SUPPORT_ASSISTANT_MANIFEST,
};

// Fail fast at module load if any manifest violates the kernel.
for (const m of new Set(Object.values(REGISTRY))) validateManifest(m);

/** Resolve a manifest by template/niche id, with base skills inherited (deduped). */
export function getManifest(id: string | null | undefined): AgentManifest {
  const m = (id && REGISTRY[id]) || CUSTOM_MANIFEST;
  return { ...m, skills: Array.from(new Set([...BASE_SKILLS, ...m.skills])) };
}

export function listManifests(): AgentManifest[] {
  // De-duplicate (whop has two aliases) and apply base inheritance.
  return Array.from(new Set(Object.values(REGISTRY))).map(m => getManifest(m.id));
}
