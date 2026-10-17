/**
 * Project templates — no-code presets a builder (or the Space Assistant) can stamp onto a
 * project in one call. "The builder/assistant configures a project ... a template is the
 * starting point so the builder only edits form fields, never writes code."
 *
 * Distinct from Launchpad SpaceType templates (launchpad/spacetype.ts): a SpaceType template
 * configures an entire SPACE at provisioning time; a project template configures ONE generic
 * workspace within an existing Space. Domain behavior, including external customer support,
 * belongs to installed templates/extensions and their declared channel/tool capabilities, not to
 * a customer-service project kind.
 */

import type { ChannelType } from "./channels.js";

export interface ProjectRuleSeed {
  trigger_pattern: string;
  action: "reply" | "run_script" | "human_takeover";
  reply_text?: string;
  script_name?: string;
  priority: number;
}

/** A cron-scheduled op the template seeds into scheduled_jobs (spec §05 cron-jobs.json), scoped
 *  to the project it's applied to. Deterministic, no-LLM dispatch — see A1.16.7/A1.16.13. */
export interface ScheduledJobSeed {
  name: string;
  cron_expression: string;
  script_name: string;
  params?: Record<string, unknown>;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  /** Suggested external channel for an installed extension or template to connect. */
  suggested_channel?: ChannelType;
  /** Whether this generic project is configured for an external channel. */
  external_channel_profile?: boolean;
  /** Execution ladder ceiling. A customer-facing bot never needs Tier 4/5 by default; a
   *  workspace template picks whatever tier its seeded work actually needs. */
  execution_ceiling: 1 | 2 | 3 | 4 | 5;
  daily_spend_cap_credits: number;
  /** 0/omitted = unlimited real conversations (primary threads + channel sessions) in this
   *  project — see SpaceDO migration v19. */
  max_threads?: number;
  /** Which agent this project's runs default to. Must be one of allowed_agent_ids when both
   *  are set (SpaceDO's validateAgentBinding enforces this at apply time too). */
  default_agent_id?: string;
  /** The thread-level "switch agent" allowlist. Omitted/empty = unrestricted. */
  allowed_agent_ids?: string[];
  /** Optional no-code triggers seeded by this template. These are configuration, not a
   *  structural project kind or authorization grant. */
  rules?: ProjectRuleSeed[];
  /** Cron-scheduled ops seeded into this project on template application. */
  scheduled_jobs?: ScheduledJobSeed[];
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
    external_channel_profile: true,
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
    external_channel_profile: true,
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
    external_channel_profile: true,
    execution_ceiling: 3,
    daily_spend_cap_credits: 3000,
    rules: BASELINE_RULES,
  },
  // ── Generic workspace templates — schedule/observation-driven ──
  {
    id: "community-member-monitoring",
    name: "Community Member Monitoring",
    description:
      "A weekly check-in on your community: the support agent reviews activity and pings you " +
      "with anything worth knowing. This workspace runs on a schedule, not in reaction to inbound messages.",
    execution_ceiling: 2,
    daily_spend_cap_credits: 1000,
    default_agent_id: "launchpad-support-v1",
    allowed_agent_ids: ["launchpad-support-v1", "naelao-agent"],
    scheduled_jobs: [
      {
        name: "Weekly community digest",
        cron_expression: "0 9 * * 1",
        script_name: "notifications.notify",
        params: { message: "Weekly community check-in: review activity and flag anything that needs attention." },
      },
    ],
  },
];

export function getProjectTemplate(id: string): ProjectTemplate | null {
  return PROJECT_TEMPLATES.find((t) => t.id === id) ?? null;
}

/**
 * Validate the catalogue: every template is a complete, safe, internally-consistent starting
 * point (spec framing: "no required follow-up edits before it's usable"). Throws on a
 * structural error (called at module load to fail fast) — same pattern as
 * launchpad/spacetype.ts's validateLaunchpadSpaceType.
 */
export function validateProjectTemplates(templates: ProjectTemplate[] = PROJECT_TEMPLATES): void {
  const seen = new Set<string>();
  for (const t of templates) {
    if (seen.has(t.id)) throw new Error(`Project template: duplicate id '${t.id}'`);
    seen.add(t.id);

    if (t.execution_ceiling < 1 || t.execution_ceiling > 5) {
      throw new Error(`Project template '${t.id}': execution_ceiling must be 1-5`);
    }
    if (t.daily_spend_cap_credits <= 0) {
      throw new Error(`Project template '${t.id}': daily_spend_cap_credits must be > 0 (no runaway-bill template)`);
    }
    if (t.default_agent_id && t.allowed_agent_ids && t.allowed_agent_ids.length > 0 && !t.allowed_agent_ids.includes(t.default_agent_id)) {
      throw new Error(`Project template '${t.id}': default_agent_id '${t.default_agent_id}' must be included in allowed_agent_ids`);
    }
    for (const r of t.rules ?? []) {
      if (r.action === "reply" && !r.reply_text) {
        throw new Error(`Project template '${t.id}': a 'reply' rule requires reply_text`);
      }
      if (r.action === "run_script" && !r.script_name) {
        throw new Error(`Project template '${t.id}': a 'run_script' rule requires script_name`);
      }
    }
  }
}

// Fail fast at import if the catalogue is malformed.
validateProjectTemplates();
