/**
 * Project templates — no-code presets for customer-facing bot projects (WhatsApp/Discord/
 * Slack business bots). "The builder/assistant configures a project to be externally
 * accessible and connects it to a channel" — a template is the starting point so the builder
 * only edits form fields (rules, replies, caps), never writes code.
 *
 * Distinct from Launchpad SpaceType templates (launchpad/spacetype.ts): a SpaceType template
 * configures an entire SPACE at provisioning time; a project template configures ONE PROJECT
 * within an already-existing space (e.g. a Whop-seller space adding a "Support WhatsApp Bot"
 * project alongside its existing Members/Support/Content projects).
 *
 * Every template ships the same baseline safety rules (STOP/opt-out, human-takeover keyword)
 * because compliance shouldn't depend on the builder remembering to add them.
 */

import type { ChannelType } from "./channels.js";

export interface ProjectRuleSeed {
  trigger_pattern: string;
  action: "reply" | "run_script" | "human_takeover";
  reply_text?: string;
  script_name?: string;
  priority: number;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  suggested_channel: ChannelType;
  /** Execution ladder ceiling — a customer-facing bot never needs Tier 4/5 by default. */
  execution_ceiling: 1 | 2 | 3 | 4 | 5;
  daily_spend_cap_credits: number;
  rules: ProjectRuleSeed[];
}

// Baseline compliance rules every customer-bot template includes (highest priority — checked
// first). STOP/unsubscribe is a WhatsApp Business Platform requirement, not just good practice.
const BASELINE_RULES: ProjectRuleSeed[] = [
  { trigger_pattern: "STOP", action: "reply", reply_text: "You've been unsubscribed and won't receive further messages. Reply START to resubscribe.", priority: 1000 },
  { trigger_pattern: "UNSUBSCRIBE", action: "reply", reply_text: "You've been unsubscribed and won't receive further messages. Reply START to resubscribe.", priority: 1000 },
  { trigger_pattern: "talk to a human", action: "human_takeover", priority: 900 },
  { trigger_pattern: "speak to a person", action: "human_takeover", priority: 900 },
];

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: "whatsapp-support-bot",
    name: "WhatsApp Support Bot",
    description: "Answers customer questions on your WhatsApp Business number. Read-only by default — it can look things up and reply, never run code or touch external services.",
    suggested_channel: "whatsapp",
    execution_ceiling: 2,
    daily_spend_cap_credits: 2000,
    rules: [
      ...BASELINE_RULES,
      { trigger_pattern: "hours", action: "reply", reply_text: "We're open Monday-Friday, 9am-5pm. We'll reply to your message as soon as we're back.", priority: 10 },
      { trigger_pattern: "hi", action: "reply", reply_text: "Hi! Thanks for reaching out — how can we help?", priority: 1 },
    ],
  },
  {
    id: "discord-community-bot",
    name: "Discord Community Bot",
    description: "Answers member questions in your Discord server. Same restricted execution as the WhatsApp template — talk and look things up, nothing else.",
    suggested_channel: "discord",
    execution_ceiling: 2,
    daily_spend_cap_credits: 2000,
    rules: [
      { trigger_pattern: "talk to a human", action: "human_takeover", priority: 900 },
      { trigger_pattern: "speak to a person", action: "human_takeover", priority: 900 },
      { trigger_pattern: "rules", action: "reply", reply_text: "Check the #rules channel for our community guidelines.", priority: 10 },
    ],
  },
  {
    id: "email-support-bot",
    name: "Email Support Bot",
    description: "Drafts replies to inbound support email. Slightly higher ceiling (Tier 3) so it can pull data via a script when answering, still no browser/container access.",
    suggested_channel: "email",
    execution_ceiling: 3,
    daily_spend_cap_credits: 3000,
    rules: BASELINE_RULES,
  },
];

export function getProjectTemplate(id: string): ProjectTemplate | null {
  return PROJECT_TEMPLATES.find((t) => t.id === id) ?? null;
}
