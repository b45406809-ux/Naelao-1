/** Legacy type contract retained for existing stored manifests. This module registers no fixed
 * business personas or business templates; FDE Space Templates are distributed by the marketplace. */

/** An agent definition exactly in the §11 shape (stored in SpaceDO.agent_definitions). */
export interface LaunchpadAgentDefinition {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  /** Preferred model for this agent. Currently UNREAD — every dispatch path resolves the model
   *  from the space's own productConfig.modelConfig (or the platform default), so this is
   *  documentation rather than configuration. Kept in sync with DEFAULT_WORKING_MODEL anyway: it
   *  previously named a Claude id that 404s on a gateway with no Anthropic provider, which is
   *  exactly the failure that killed the first real unattended cron run when a live path DID fall
   *  back to a hardcoded id. A dead field naming a broken value is a trap for whoever wires it up. */
  model: string;
  /** Marketplace skill ids the agent may call. */
  allowed_skills: string[];
  /** What wakes the agent: webhook, schedule, or owner/chat message. */
  trigger: { type: "webhook" | "schedule" | "manual"; event?: string; source?: string; cron?: string };
  /** Actions that must get owner approval before they execute (Autopilot guardrail). */
  requires_approval_for: string[];
  /** Hard per-action spend ceiling in USD (0 = no autonomous spend). */
  max_spend_per_action_usd: number;
  /** Compute tier the agent runs at. */
  resource_tier: "isolate" | "workspace" | "container";
}

/**
 * A first-run setup question the onboarding wizard asks when a space is created from a template.
 * Credentials route to the vault; choices/text/booleans become space preferences the agents read.
 */
export interface OnboardingPrompt {
  id: string;
  /**
   * - "connection" — the app's own click-through connect flow (OAuth, or a provider-hosted link).
   *   ALWAYS prefer this over "credential" for any connector that has one: a non-technical owner
   *   should never be asked to find and paste an API key when "Connect with Whop" exists.
   * - "credential" — a raw key/secret pasted into the vault. Only for connectors with no connect
   *   flow at all, or as an explicit fallback beside a "connection" prompt for the same connector.
   * - "channel" — pick + configure the channel the assistant reaches the owner on (approvals,
   *   plans, escalations). Distinct from a connector: this is how the BUSINESS talks to its OWNER,
   *   not how it talks to an external platform.
   * - "choice"/"text"/"boolean" — plain preferences stored on the space for agents to read.
   */
  type: "connection" | "credential" | "channel" | "choice" | "text" | "boolean";
  question: string;
  /** Extra context shown under the question — what this unlocks, in plain language. Written for
   *  a non-technical owner, never for a developer. */
  help?: string;
  /** For type "credential"/"connection": the connector id being connected. */
  connector?: string;
  /** For type "choice": the options offered. */
  options?: string[];
  required?: boolean;
}

/**
 * What the assistant does the moment onboarding finishes — the "it contacts you and tells you the
 * plan" behavior. This is the difference between a configured space and a business that has
 * actually started: the owner should hear from their assistant on the channel they just picked,
 * with a concrete plan and whatever needs their approval, without having to open the app and ask.
 */
export interface TemplateFirstContact {
  /** The goal handed to the Space Assistant on its very first proactive run. Written as an
   *  instruction to the assistant, not as text shown to the owner — the assistant composes the
   *  actual message itself so it can reference what it really found in the connected account. */
  goal: string;
}

/**
 * An initial project a template seeds, optionally pre-bound to one of the template's installed
 * agents. The binding is a DEFAULT only — projects.default_agent_id (SpaceDO migration v18) is
 * never an enforced identity, and the builder or Space Assistant can reassign/clear it at any
 * time via PATCH. A project with no default_agent_id (e.g. "Products", a reference/data project)
 * is intentionally unbound — nothing runs there automatically.
 */
export interface TemplateProjectSeed {
  name: string;
  /** A LaunchpadAgentDefinition.id from this same template's `agents` list. */
  default_agent_id?: string;
}

/**
 * Template bootstrap (the "as you start, everything is set up" flow). On space creation the
 * provisioner installs the prebuilt agents (template.agents), seeds the skill library, then the
 * Space Assistant runs this: ask the prompts (credentials + preferences), create the initial
 * projects (each with a starter thread when it has a default_agent_id), and run the setup
 * scripts to finish wiring the business.
 */
export interface TemplateBootstrap {
  /** Questions asked on first run (credentials to connect, preferences to set). */
  prompts: OnboardingPrompt[];
  /**
   * Initial projects (thread groups) to create in the space. A plain string is a name-only,
   * unbound project (equivalent to `{ name }`) — kept so existing/simple templates don't need
   * the object form.
   */
  projects?: Array<string | TemplateProjectSeed>;
  /** Prebuilt script ops the assistant runs on start to finish setup. */
  setup_scripts?: string[];
  /** Project templates (project-templates.ts ids) stamped into the space at bootstrap — the
   *  pre-configured project presets a template ships, distinct from `projects` (which are plain
   *  named thread-groups). These presets cannot grant external customer-bot behavior; that is
   *  provided by an explicitly installed and connected extension. */
  project_templates?: string[];
  /** What the assistant proactively does once onboarding completes. */
  first_contact?: TemplateFirstContact;
}

/** A Launchpad template: a pre-wired digital-business model the owner can pick. */
export interface LaunchpadTemplate {
  id: string;
  name: string;
  description: string;
  /** Initial shell complexity for this template. Users may change it per Space. */
  presentation_profile?: "guided" | "balanced" | "advanced";
  /** @deprecated Legacy catalog classification retained for stored-template compatibility; all templates now use the same Space and autonomy model. */
  template_mode?: "ave" | "cowork";
  /** Domain/focus metadata for filtering and setup copy; not an operating-system mode. */
  vertical?: string;
  /** Core agent ids this template installs (subset/superset of LAUNCHPAD_CORE_AGENTS). */
  agents: string[];
  /** Marketplace skills the template needs wired (commerce/Lemon Squeezy, email, etc.). */
  skills: string[];
  free_tier_eligible: boolean;
  /** External-platform connectors this template wires (ids in the connector catalogue). */
  connectors?: string[];
  /** First-run setup flow: prompts (credentials + preferences), projects, setup scripts. */
  bootstrap?: TemplateBootstrap;
  /**
   * When true the dashboard renders the template greyed out as "Coming soon" — selectable once
   * its connector/provider is configured. Availability is data, not a platform-wide Whop assumption.
   */
  coming_soon?: boolean;
  /**
   * The template's published price list, when it sells a fixed set of packages.
   *
   * One source of truth for two consumers that must not disagree: the storefront the assistant
   * provisions, and whatever skill prices a job. A quote naming a number the store cannot
   * actually sell is a customer-facing error, so they read the same list rather than each
   * carrying their own copy.
   *
   * A range (min !== max) means the tier is genuinely scoped per job — the agent is expected to
   * quote within it and say what it is still unsure of, not to pick the midpoint silently.
   */
  pricing_tiers?: Array<{
    id: string;
    name: string;
    price_usd_min: number;
    price_usd_max: number;
    summary: string;
    includes: string[];
  }>;
}

/**
 * AVOS plan step 7 ("Declarative Business Blueprint Marketplace & Market Radar") proposed a NEW
 * `BlueprintProjectSpec` type + `blueprint_projects`/`knowledge_seeds`/`seed_repository_url`
 * fields on LaunchpadTemplate, "atomic" 1-click Genesis, and live `saturation_index`/
 * `opportunity_score`/`network_gmv_cents` scoring rendered as "94/100 Viability"/"Blue Ocean"
 * badges. Investigated and deliberately NOT built as proposed:
 *
 * - `blueprint_projects` would be a SECOND way to declare "what projects does this template
 *   create," alongside the TemplateBootstrap fields immediately above (`projects`,
 *   `project_templates`, `setup_scripts`) that already do exactly this and are what the real
 *   provisioner/bootstrap flow reads. Two competing declarations, one silently winning, is the
 *   split-brain CLAUDE.md's own ground rule #4 warns against.
 * - "Atomic" Genesis would be a real regression against this codebase's own deliberate,
 *   repeatedly-established convention: every provision-time seed (seedWallet, seedOwnerMember,
 *   seedBusinessEmail, seedDefaultRevenueReviewCron, ...) is explicitly best-effort/fail-soft, so
 *   a transient failure in ONE piece (a wallet provider outage, say) never strands or rolls back
 *   an otherwise-successful business creation. True cross-system atomicity (R2 + DO SQLite +
 *   external service calls) is a real distributed-transaction problem, not a flag to add.
 * - `network_gmv_cents` (exact aggregate revenue across other businesses on the same template) has
 *   a genuine deanonymization risk this codebase's own privacy discipline already accounts for
 *   elsewhere (see appendix BF.4, the Business Network's "exact figures never shared regardless of
 *   plan" rule): on a template with only 1-2 active businesses, "network GMV" IS that business's
 *   own revenue, fully identifying it to anyone who can see the badge.
 * - `saturation_index`/`opportunity_score` framed as "94/100 Viability"/"Blue Ocean" implies real
 *   external market research (TAM, competitor pricing, search-demand trends) this platform has no
 *   way to compute — fabricating a score from an internal business count and dressing it up as
 *   market intelligence is exactly the class of invented number this codebase's own convention
 *   refuses to ship (see e.g. the builder dashboard's `credits_consumed: null` precedent).
 *
 * What WAS already real, and honestly built by an earlier pass: GET /spaces/:id/template-activity
 * (workers/spaces/src/index.ts) — a cross-tenant, PII-free COUNT of active businesses per
 * template_id (a real, queryable field — see business-create.ts's own config_json.template_id).
 * The one genuine gap this step closed: that data was fetched by the shell but never actually
 * shown on the template picker cards themselves — see spaces/page.tsx's templateActivityBadge.
 */
export interface LaunchpadSpaceType {
  id: "launchpad";
  version: string;
  name: string;
  description: string;
  templates: LaunchpadTemplate[];
  core_agents: LaunchpadAgentDefinition[];
}

// ── Core agent definitions (pre-installed; §11) ──────────────────────────────
// Autonomy starting point: assistants may act within explicit boundaries; the owner reviews outputs
// before they reach customers via `requires_approval_for`.

export const LAUNCHPAD_CORE_AGENTS: LaunchpadAgentDefinition[] = [];

/*
 * Launchpad no longer ships vertical business templates or preconfigured business personas.
 * Space Templates are installed from the FDE marketplace, and every worker uses the same
 * Naelao agent runtime configured through the worker creation UI / planner delegation path.
 * Keep the empty catalog exports temporarily for persisted-space and API compatibility; they
 * must not become a second source of installable product templates.
 */
export const LAUNCHPAD_TEMPLATES: LaunchpadTemplate[] = [];

export const LAUNCHPAD_SPACETYPE: LaunchpadSpaceType = {
  id: "launchpad",
  version: "1.0.0",
  name: "Launchpad",
  description: "General Naelao Space. Product workflows are installed from Space Templates.",
  templates: LAUNCHPAD_TEMPLATES,
  core_agents: LAUNCHPAD_CORE_AGENTS,
};

const CORE_AGENT_IDS = new Set(LAUNCHPAD_CORE_AGENTS.map(a => a.id));

/** Resolve a Launchpad template by id (null when unknown). */
export function getLaunchpadTemplate(id: string | null | undefined): LaunchpadTemplate | null {
  return LAUNCHPAD_TEMPLATES.find(t => t.id === id) ?? null;
}

/** The agent definitions a template installs, resolved from the core-agent set. */
export function agentsForTemplate(templateId: string): LaunchpadAgentDefinition[] {
  const tpl = getLaunchpadTemplate(templateId);
  if (!tpl) return [];
  return tpl.agents
    .map(aid => LAUNCHPAD_CORE_AGENTS.find(a => a.id === aid))
    .filter((a): a is LaunchpadAgentDefinition => Boolean(a));
}

/** Multi-template union, deduped by agent id (a business built from several templates gets the
 *  agents each one needs, once each — order-preserving on first occurrence). Three-Tier
 *  Platform Model Phase C (§A1.17): businesses can be created from more than one template. */
export function agentsForTemplates(templateIds: string[]): LaunchpadAgentDefinition[] {
  const seen = new Set<string>();
  const result: LaunchpadAgentDefinition[] = [];
  for (const id of templateIds) {
    for (const agent of agentsForTemplate(id)) {
      if (!seen.has(agent.id)) {
        seen.add(agent.id);
        result.push(agent);
      }
    }
  }
  return result;
}

/**
 * Validate the SpaceType: every template references known core agents, and ids are unique.
 * Throws on a structural error (called at module load to fail fast).
 */
export function validateLaunchpadSpaceType(st: LaunchpadSpaceType = LAUNCHPAD_SPACETYPE): void {
  const seen = new Set<string>();
  for (const t of st.templates) {
    if (seen.has(t.id)) throw new Error(`Launchpad: duplicate template id '${t.id}'`);
    seen.add(t.id);
    if (t.presentation_profile !== undefined && !["guided", "balanced", "advanced"].includes(t.presentation_profile)) {
      throw new Error(`Launchpad template '${t.id}' has an invalid presentation profile`);
    }
    for (const aid of t.agents) {
      if (!CORE_AGENT_IDS.has(aid)) {
        throw new Error(`Launchpad template '${t.id}' references unknown core agent '${aid}'`);
      }
    }
    // A bootstrap project's default_agent_id must be one of THIS template's own installed
    // agents — a project can't default to an agent the space never provisions.
    const installedAgents = new Set(t.agents);
    for (const p of t.bootstrap?.projects ?? []) {
      if (typeof p === "string") continue;
      if (p.default_agent_id && !installedAgents.has(p.default_agent_id)) {
        throw new Error(
          `Launchpad template '${t.id}' project '${p.name}' defaults to agent '${p.default_agent_id}', which is not in this template's own agents list`
        );
      }
    }

    // A connect/credential prompt must name a connector the template actually wires — otherwise
    // onboarding renders a Connect button for an app the space was never set up to reach.
    const wiredConnectors = new Set(t.connectors ?? []);
    for (const p of t.bootstrap?.prompts ?? []) {
      if (p.type !== "connection" && p.type !== "credential") continue;
      if (!p.connector) {
        throw new Error(`Launchpad template '${t.id}' prompt '${p.id}' is type '${p.type}' but names no connector`);
      }
      if (!wiredConnectors.has(p.connector)) {
        throw new Error(
          `Launchpad template '${t.id}' prompt '${p.id}' connects '${p.connector}', which is not in this template's own connectors list`
        );
      }
    }
    // A choice prompt with no options is an unanswerable question.
    for (const p of t.bootstrap?.prompts ?? []) {
      if ((p.type === "choice" || p.type === "channel") && (p.options ?? []).length === 0) {
        throw new Error(`Launchpad template '${t.id}' prompt '${p.id}' is type '${p.type}' but offers no options`);
      }
    }
  }
}

// Fail fast at import if the SpaceType is malformed.
validateLaunchpadSpaceType();
