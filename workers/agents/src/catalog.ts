/**
 * Naelao catalog — the roadmap surface for the three-tier architecture.
 *
 *   Naelao (infra)  →  Builder (one product)  →  Users (one business each)
 *
 * v0 focuses on exactly one niche: the Whop Businesses template under the
 * Launchpad space type — an AI-run micro-tool + community sold on Whop. Every
 * other space type / template / product niche is real in the *roadmap* but
 * marked `coming_soon`, so:
 *   - the founder's dev dashboard shows other space types & templates as
 *     "coming soon" (builder view, founder-only), and
 *   - the product shows other Whop-business niches as "coming soon" (user view).
 *
 * This is read-only data — not a configuration system. Nothing here is editable
 * by builders or users; new niches ship as code when demand is proven.
 */

export type CatalogStatus = "live" | "coming_soon";

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  status: CatalogStatus;
}

// ── Builder/dev view (founder-only): platform space types ────────────────────
// Launchpad is live; the rest are the eventual Naelao surface, shown as coming soon.
export const SPACE_TYPES: CatalogEntry[] = [
  { id: "launchpad", name: "Launchpad", description: "Autonomous agent that builds and runs a business for you — and (later) lets builders build their own.", status: "live" },
  { id: "workers", name: "Workers", description: "A virtual workforce of task-running agents.", status: "coming_soon" },
  { id: "sites", name: "Sites", description: "Agent-managed content sites and CMS.", status: "coming_soon" },
  { id: "enterprise", name: "Enterprise", description: "Org-level sub-spaces, roles, and orchestration.", status: "coming_soon" },
  { id: "studio", name: "Studio", description: "Creative production environment.", status: "coming_soon" },
  { id: "developer", name: "Developer", description: "Warm containers, live preview, build sandboxes.", status: "coming_soon" },
];

// ── Builder/dev view: templates under Launchpad ──────────────────────────────
export const TEMPLATES: CatalogEntry[] = [
  { id: "whop-businesses", name: "Whop Businesses", description: "AI-built micro-tool + community, sold on Whop, run by a script-first agent loop.", status: "live" },
  { id: "whop-courses", name: "Whop Courses", description: "Agent-run course + community product.", status: "coming_soon" },
  { id: "whop-saas", name: "Whop SaaS", description: "Agent-run micro-SaaS sold on Whop.", status: "coming_soon" },
];

// ── Product/user view: Whop-business niches a user can launch ─────────────────
// One is live; others are surfaced as "coming soon" inside the product.
export const PRODUCT_NICHES: CatalogEntry[] = [
  { id: "ai-microtool-community", name: "AI Micro-Tool + Community", description: "A genuinely functional AI micro-tool bundled with a support community.", status: "live" },
  { id: "custom", name: "Describe your own business", description: "Tell the agent what you want — it figures out how to build and run it (full live reasoning, costs more).", status: "live" },
  { id: "content-engine", name: "Content Engine", description: "Repurpose one piece of content into many, with a community.", status: "coming_soon" },
  { id: "outreach-agency", name: "Outreach Autopilot", description: "Automated outreach tooling + community.", status: "coming_soon" },
  { id: "niche-research", name: "Niche Research", description: "Find underserved niches and offers, with a community.", status: "coming_soon" },
];

/** Builder/dev catalog (founder-only): the platform roadmap. */
export function devCatalog(): { space_types: CatalogEntry[]; templates: CatalogEntry[] } {
  return { space_types: SPACE_TYPES, templates: TEMPLATES };
}

/** Product catalog (end-user): the one live niche + others coming soon. */
export function productCatalog(): { niches: CatalogEntry[]; live_count: number; coming_soon_count: number } {
  const live = PRODUCT_NICHES.filter(n => n.status === "live");
  return {
    niches: PRODUCT_NICHES,
    live_count: live.length,
    coming_soon_count: PRODUCT_NICHES.length - live.length,
  };
}

/** The single live niche a user actually launches in v0. */
export function liveNiche(): CatalogEntry {
  return PRODUCT_NICHES.find(n => n.status === "live")!;
}
