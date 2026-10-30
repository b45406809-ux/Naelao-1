/**
 * Project-template compatibility surface. Product-specific project presets are distributed
 * through FDE-authored Space Templates; the core runtime does not ship business personas.
 *
 * Distinct from Launchpad SpaceType templates (launchpad/spacetype.ts): a SpaceType template
 * configures an entire SPACE at provisioning time; a project template configures ONE generic
 * workspace within an existing Space. External customer behavior belongs to installed
 * extensions and their declared channel/data capabilities; generic project presets cannot
 * impersonate or automatically install that behavior.
 */

import type { ChannelType } from "./channels.js";

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
  /** Cron-scheduled ops seeded into this project on template application. */
  scheduled_jobs?: ScheduledJobSeed[];
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
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
  }
}

// Fail fast at import if the catalogue is malformed.
validateProjectTemplates();
