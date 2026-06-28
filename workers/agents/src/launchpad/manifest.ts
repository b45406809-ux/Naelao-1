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
}

import { WHOP_MANIFEST } from "./templates/whop-businesses.js";
import { CUSTOM_MANIFEST } from "./templates/custom.js";
import { SUPPORT_ASSISTANT_MANIFEST } from "./templates/support-assistant.js";

const REGISTRY: Record<string, AgentManifest> = {
  "whop-businesses-v1": WHOP_MANIFEST,
  "whop-businesses": WHOP_MANIFEST,
  "custom": CUSTOM_MANIFEST,
  "support-assistant": SUPPORT_ASSISTANT_MANIFEST,
};

/** Resolve a manifest by template/niche id. Unknown ids fall back to custom (L4). */
export function getManifest(id: string | null | undefined): AgentManifest {
  return (id && REGISTRY[id]) || CUSTOM_MANIFEST;
}

export function listManifests(): AgentManifest[] {
  // De-duplicate (whop has two aliases).
  return Array.from(new Set(Object.values(REGISTRY)));
}
