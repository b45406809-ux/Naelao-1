import type { AgentManifest } from "../manifest.js";

/**
 * A Space Assistant — the spec's "glorified agent." Same script-first engine, but the
 * manifest grants channel capabilities (the OpenClaw-style integrations) and a
 * heartbeat skill, so it behaves like a continuously-running assistant rather than a
 * nightly business loop. `kind: "assistant"` is the only structural difference; the
 * "glorification" is entirely in the bundle (channels + skills + instructions).
 *
 * Included to prove the abstraction: an assistant is not a new system, it's a manifest.
 */
export const SUPPORT_ASSISTANT_MANIFEST: AgentManifest = {
  id: "support-assistant",
  kind: "assistant",
  name: "Support Assistant",
  description: "A continuously-running assistant that fields member questions across channels.",
  cost_multiplier: 1,
  channels: ["email", "slack", "discord"],
  skills: ["observe-first", "verify-landed"],
  capabilities: ["read_channel", "reply_in_channel", "search_knowledge", "escalate_to_human"],
  instructions:
    "You are a continuously-running Space Assistant. You monitor connected channels " +
    "(email/Slack/Discord) on a heartbeat, answer member questions grounded in the Space's " +
    "knowledge, and escalate anything you're unsure about to a human rather than guessing. " +
    "Never fabricate an answer; an honest escalation beats a confident wrong reply.",
  seed_scripts: [
    {
      name: "heartbeat_check_channels",
      description: "Heartbeat: poll connected channels for unanswered member messages",
      tier: 2,
      preconditions: ["at least one channel connected"],
      code: `
// Heartbeat: gather unanswered messages across connected channels for triage.
const pending = await channels.listUnanswered(state.channels ?? []);
return { pending_count: pending.length, pending };`.trim(),
    },
  ],
};
