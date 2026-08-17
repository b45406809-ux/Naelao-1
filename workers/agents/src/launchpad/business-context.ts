/**
 * What business is this agent actually running?
 *
 * Found by driving a real business end-to-end on production: asked "what is this business and
 * what should I do first to get a paying customer?", the Space Assistant answered that it was
 * "a digital business built using the Launchpad Space" and recommended the owner "scaffold
 * projects using the workspace-admin, mcp-connector, commerce and storefront prebuilts". Both
 * halves of that are the same defect — the reasoner payload carries `who_you_are` (a digest of
 * the STATIC agent profile), the goal, the thread history and a technical state fingerprint, and
 * nothing whatsoever about the business itself. With no idea that it runs a web-design studio
 * called Pixel Forge Studio whose setup is unfinished, the only thing left to describe is its own
 * machinery, so that is what it described.
 *
 * An autonomous business runner that does not know which business it runs cannot run it. This is
 * the smallest honest fix: the space row is ALREADY fetched on every /agent/run (for the model
 * override) and its `name` + `config_json` already carry the template id and onboarding status,
 * so resolving identity costs zero extra queries and one KB of prompt.
 *
 * Deliberately NOT included: projects, agents, connectors, revenue. Those change per-run, cost a
 * round trip each, and the agent already has real tools for them (`project.list`, `agent.list`,
 * `diagnostics.overview`, `business_wallet.balance`). This carries only what is true for the whole
 * life of the business and cheap enough to send every single turn.
 */

import { getLaunchpadTemplate } from "./spacetype.js";

/** The standing facts about a business, small enough to send on every reasoning turn. */
export interface BusinessContext {
  /** The business's own name, as its owner named it. */
  name: string;
  /** Template id — the KIND of business ("whop-webdev-agency"). Absent for an untemplated space. */
  kind?: string;
  /** One line: what this business actually sells and how it makes money. */
  offering?: string;
  /**
   * The business's own published price list, when its template defines one.
   *
   * Added after a live run: asked "I want to charge more than $10, what should my prices be?",
   * the assistant recommended reviewing costs, market and competition — generic consulting advice,
   * given by an assistant whose own template ships a four-tier price list covering exactly that
   * question. An owner asking what to charge is asking about THIS business's prices, and it is a
   * fact we hold rather than something to reason about.
   */
  pricing?: string;
  /** "complete" once the owner finished setup; otherwise what stage it is at. */
  setup_status: string;
  /**
   * Present ONLY while setup is unfinished. Phrased as a fact about the business plus what to do
   * about it, because the model reads this and speaks to the owner — a bare status enum produced
   * either silence or the word "awaiting_setup" quoted back at a non-technical business owner.
   */
  setup_note?: string;
}

/** Shape of the parts of `spaces.config_json` this reads. Everything is optional — a space
 *  created before any of these fields existed must still resolve, just with less to say. */
export interface SpaceConfigForContext {
  template_id?: unknown;
  onboarding?: { status?: unknown; template_ids?: unknown } | undefined;
}

/** `complete` is the only status that means the owner is actually done. Everything else —
 *  `awaiting_setup`, `pending`, an unset field on a legacy row — means work remains. */
const COMPLETE = "complete";

/**
 * Build the standing business context from data the caller already holds.
 *
 * Pure and total: any missing or malformed field degrades to a smaller context rather than
 * throwing, because failing to describe the business must never fail the run that needed it.
 */
export function resolveBusinessContext(input: {
  spaceName?: string | null;
  config: SpaceConfigForContext | null | undefined;
}): BusinessContext {
  const name = (input.spaceName ?? "").trim() || "this business";
  const cfg = input.config ?? {};

  // The template id lives at the top level of config_json, with the onboarding record carrying
  // its own copy for multi-template businesses. Prefer the top-level one, fall back to the first
  // onboarding template — the same precedence business-routes.ts's own listing query uses.
  const topLevel = typeof cfg.template_id === "string" ? cfg.template_id : undefined;
  const fromOnboarding = Array.isArray(cfg.onboarding?.template_ids)
    ? (cfg.onboarding?.template_ids as unknown[]).find((t): t is string => typeof t === "string" && t.length > 0)
    : undefined;
  const kind = topLevel || fromOnboarding;

  const rawStatus = cfg.onboarding?.status;
  const setupStatus = typeof rawStatus === "string" && rawStatus.trim() ? rawStatus.trim() : "pending";

  const ctx: BusinessContext = { name, setup_status: setupStatus };
  if (kind) ctx.kind = kind;

  // The template's own published description is what the business sells. Using it rather than a
  // hand-written second copy means a template's pricing or positioning can never drift out of
  // sync with what its assistant believes it is selling.
  const template = kind ? getLaunchpadTemplate(kind) : undefined;
  if (template) {
    const desc = (template.description ?? "").trim();
    ctx.offering = desc ? `${template.name} — ${desc}` : template.name;

    // A range (min !== max) is rendered as a range on purpose: the template's own comment is that
    // such a tier is scoped per job and the agent is expected to quote WITHIN it and say what it
    // is still unsure of, never to silently pick the midpoint. Flattening it to one number here
    // would quietly delete that instruction.
    const tiers = template.pricing_tiers ?? [];
    if (tiers.length) {
      ctx.pricing = tiers
        .map((t) => {
          const price =
            t.price_usd_min === t.price_usd_max
              ? `$${t.price_usd_min}`
              : `$${t.price_usd_min}-${t.price_usd_max}`;
          return `${t.name} ${price}`;
        })
        .join("; ");
    }
  }

  if (setupStatus !== COMPLETE) {
    // Wording tuned against live answers, twice.
    //
    // The first version said finishing setup was "their first step, ahead of any other advice",
    // and the model read that as permission to stop: asked what to charge for a website, it
    // replied only that setup was unfinished and answered nothing. That is worse than the generic
    // advice it replaced — the owner asked a question that has a real answer today, and got a
    // deflection. Being blocked on setup is a fact to mention, never a reason to refuse.
    ctx.setup_note =
      "Setup is NOT finished yet, so this business cannot take payment or run its automations " +
      "until the owner completes it. ALWAYS answer what the owner actually asked first, in full — " +
      "most questions (pricing, positioning, how something works) have a real answer regardless of " +
      "setup. Then add a brief note that setup is still unfinished and point them at the setup " +
      "checklist on the business page. Never use unfinished setup as a reason to avoid answering, " +
      "and never claim the business is already trading.";
  }

  return ctx;
}

/**
 * Parse a raw `spaces.config_json` string into the shape `resolveBusinessContext` reads.
 * Malformed JSON yields an empty config rather than throwing — same posture as every other
 * config_json read in this codebase.
 */
export function parseSpaceConfigForContext(configJson: string | null | undefined): SpaceConfigForContext {
  try {
    const parsed = JSON.parse(configJson || "{}") as SpaceConfigForContext;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The single row this needs, structurally typed so a test can supply a plain object instead of
 *  standing up a whole D1 double. */
export interface SpaceNameAndConfigQuery {
  prepare(query: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null> };
  };
}

/**
 * Load the business context for a space that the caller has NOT already fetched.
 *
 * `/agent/run` never needs this — it already holds the space row. This exists for the wake paths
 * (the channel heartbeat above all) where a run is started by the platform rather than by a
 * request that looked the space up. Those runs are the ones answering a real customer on WhatsApp
 * or Slack, so being unable to say what the business sells is worse there than in the owner's own
 * chat, not better.
 *
 * One indexed primary-key read, and never fatal: any failure returns undefined and the run
 * proceeds exactly as it did before this existed.
 */
export async function loadBusinessContext(
  db: SpaceNameAndConfigQuery | undefined,
  spaceId: string,
  tenantId: string
): Promise<BusinessContext | undefined> {
  if (!db || !spaceId) return undefined;
  try {
    const row = await db
      .prepare("SELECT name, config_json FROM spaces WHERE id = ? AND tenant_id = ?")
      .bind(spaceId, tenantId)
      .first<{ name: string | null; config_json: string | null }>();
    if (!row) return undefined;
    return resolveBusinessContext({
      spaceName: row.name,
      config: parseSpaceConfigForContext(row.config_json),
    });
  } catch {
    return undefined;
  }
}
