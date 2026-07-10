/**
 * F-3d — Prebuilt business-scaling skills library.
 *
 * Six agent-authored skills the Launchpad Space Assistant can discover via `script.find` and wire
 * into its business methodology ("scale from $0 to $10k MRR", "optimize pricing", "build a brand").
 * These are ORDINARY stored scripts (Tier 2 isolates, `export async function run(args, ctx)`) — not
 * hardcoded features — seeded into each Launchpad space's own skill library at provision time so a
 * builder never starts from scratch, and forkable/customizable like any other script.
 *
 * They are deliberately METHODOLOGY orchestrators: each returns a structured, actionable plan (and
 * where it can, invokes real capability scripts via `ctx.run` — commerce, notifications, mcp-connector,
 * script.find). Well-tagged so `script.find` retrieves them even before embeddings are computed
 * (find degrades to a tag/text scan; the embedder fills in `embedding_vector` at create time when
 * one is wired). Kept dependency-free and side-effect-light so seeding can't fail a provision.
 */

export interface ScalingSkill {
  name: string;
  description: string;
  domain: string;
  tags: string[];
  code: string;
}

// Each skill's code: a small, real orchestration script. `args`/`ctx` are the standard stored-script
// contract; `ctx.run(op, params)` invokes any prebuilt op or library script. They favor producing a
// concrete, ordered plan the assistant then executes step-by-step (honest — no black-box autonomy).

const SCALING_ZERO_TO_TEN_K = `
export async function run(args, ctx) {
  const target = args.target_mrr ?? 10000;
  const current = args.current_mrr ?? 0;
  // Incremental ladder: PMF → repeat sales → scale channels → team handoff.
  const stages = [
    { name: "product_market_fit", goal: "10 paying customers who would be disappointed without you", done: current > 0 },
    { name: "repeat_sales", goal: "A repeatable sale: one channel that converts predictably", done: current >= target * 0.1 },
    { name: "scale_channels", goal: "Add a 2nd and 3rd acquisition channel; double down on what works", done: current >= target * 0.5 },
    { name: "team_handoff", goal: "Document + delegate fulfilment so growth isn't owner-bound", done: current >= target },
  ];
  const nextStage = stages.find((s) => !s.done) ?? stages[stages.length - 1];
  return {
    target_mrr: target, current_mrr: current,
    focus_stage: nextStage.name, focus_goal: nextStage.goal,
    ladder: stages,
    next_actions: [
      "Interview 5 recent customers on why they bought (find the real value prop)",
      "Pick ONE channel and run it for 2 weeks before adding another",
      "Track weekly: new MRR, churned MRR, and the single metric that predicts each",
    ],
  };
}`;

const STOREFRONT_SETUP = `
export async function run(args, ctx) {
  // Configure a product catalog with tiered pricing + an upsell bundle. Uses the reserved
  // commerce script to create real products when a catalog is provided, else returns the plan.
  const products = args.products ?? [];
  const created = [];
  for (const p of products) {
    try {
      const r = await ctx.run("commerce.create_product", { name: p.name, price_cents: p.price_cents, kind: p.kind ?? "one_time", description: p.description });
      created.push({ name: p.name, id: r?.id ?? null });
    } catch (e) { created.push({ name: p.name, error: String(e && e.message || e) }); }
  }
  return {
    created,
    recommendations: [
      "Offer 3 tiers (good/better/best) — most buyers pick the middle; the top anchors value",
      "Add one upsell bundle at ~1.5x a single item for ~2.2x the value",
      "Name tiers by outcome, not feature count",
    ],
  };
}`;

const PRICING_OPTIMIZATION = `
export async function run(args, ctx) {
  // Analyze current revenue + (optionally) competitor pricing via a connected MCP research tool,
  // then recommend a change. Read-only — never changes a price without the owner's approval.
  const current = args.current_price_cents ?? null;
  let competitors = args.competitor_prices_cents ?? [];
  if ((!competitors || competitors.length === 0) && args.research_query) {
    try {
      const found = await ctx.run("mcp.call", { server: args.research_server ?? "research", tool_name: "search", input: { q: args.research_query } });
      competitors = (found && found.prices) || [];
    } catch (_) { /* research is optional */ }
  }
  const avg = competitors.length ? Math.round(competitors.reduce((a, b) => a + b, 0) / competitors.length) : null;
  let recommendation = "Hold price; gather more demand data before changing.";
  if (current != null && avg != null) {
    if (current < avg * 0.7) recommendation = "You are underpriced vs the market — test a 15-25% increase on new customers only.";
    else if (current > avg * 1.3) recommendation = "You are priced above the market — justify with a clearer premium outcome or add a lower tier.";
  }
  return { current_price_cents: current, market_avg_cents: avg, recommendation, method: "Test on NEW customers first; never surprise existing ones." };
}`;

const BRAND_IDENTITY = `
export async function run(args, ctx) {
  // Discover current brand gaps and recommend a positioning + visual direction. Sourcing a
  // freelancer (if requested) is a follow-up the assistant runs, not done here.
  const name = args.business_name ?? "your business";
  return {
    positioning_prompts: [
      "In one sentence: who is it for, and what painful status quo does it replace?",
      "What is the ONE feeling a customer should have using it?",
      "What would a competitor never say about themselves that you can?",
    ],
    visual_direction: {
      recommendation: "Pick 1 primary color + 1 accent, one display + one body typeface, and a single logo mark. Consistency beats cleverness.",
      deliverables: ["logo mark", "color tokens", "one-line tagline", "voice guidelines (3 do/don'ts)"],
    },
    next: "Once positioning is confirmed, draft copy for the storefront hero + generate a logo brief for a freelancer.",
    business_name: name,
  };
}`;

const SALES_OUTREACH = `
export async function run(args, ctx) {
  // Draft a cold-email campaign with an A/B subject test. Sending goes through the notifications /
  // business-email script the assistant runs after the owner approves the copy.
  const audience = args.audience ?? "your ideal customer";
  const offer = args.offer ?? "your product";
  return {
    campaign: {
      audience, offer,
      subject_a: "Quick question about " + audience,
      subject_b: offer + " for " + audience + "?",
      body: "Hi {{first_name}} — noticed you {{trigger}}. We help " + audience + " " + (args.value ?? "get {{outcome}} without {{pain}}") + ". Worth a 10-min look? — {{sender}}",
      steps: ["Day 0: send", "Day 3: one-line bump", "Day 7: break-up + a resource, no ask"],
    },
    guardrails: ["Personalize the first line or don't send", "One clear ask per email", "Honor STOP/opt-out on every send"],
  };
}`;

const CUSTOMER_RETENTION = `
export async function run(args, ctx) {
  // Churn analysis + win-back + a simple loyalty structure. Reads the wallet/orders context the
  // assistant passes in; drafts campaigns rather than firing them.
  const churnRatePct = args.churn_rate_pct ?? null;
  const atRisk = args.at_risk_customers ?? [];
  return {
    churn_rate_pct: churnRatePct,
    win_back: {
      trigger: "No purchase/login in 30 days",
      message: "We miss you, {{first_name}} — here's {{incentive}} to pick up where you left off.",
      at_risk_count: atRisk.length,
    },
    loyalty: {
      recommendation: "Reward the 2nd and 5th purchase (habit formation), not just the 10th. Keep it one simple rule customers can state from memory.",
    },
    focus: churnRatePct != null && churnRatePct > 5
      ? "Churn is high — fix onboarding/first-value BEFORE spending on acquisition."
      : "Retention is healthy — a small loyalty nudge compounds; don't over-engineer it.",
  };
}`;

export const LAUNCHPAD_SCALING_SKILLS: readonly ScalingSkill[] = [
  { name: "scaling-zero-to-ten-k", domain: "strategy", code: SCALING_ZERO_TO_TEN_K,
    description: "Scale a business from $0 toward $10k MRR — an incremental ladder (product-market fit → repeat sales → scaling channels → team handoff) that picks the current focus stage and next actions.",
    tags: ["scale", "growth", "mrr", "revenue", "roadmap", "zero to ten k", "business plan", "strategy"] },
  { name: "storefront-setup", domain: "commerce", code: STOREFRONT_SETUP,
    description: "Set up a product catalog with tiered pricing and an upsell bundle, creating real products via the commerce script when given a catalog.",
    tags: ["storefront", "catalog", "products", "pricing tiers", "upsell", "bundle", "setup", "commerce"] },
  { name: "pricing-optimization", domain: "strategy", code: PRICING_OPTIMIZATION,
    description: "Analyze current revenue and competitor pricing (via a connected research MCP) and recommend a price change, tested on new customers first.",
    tags: ["pricing", "optimize price", "competitor research", "revenue", "willingness to pay", "strategy"] },
  { name: "brand-identity", domain: "strategy", code: BRAND_IDENTITY,
    description: "Discover brand gaps and recommend positioning + a visual direction (colors, type, logo brief, tagline, voice), ready to hand to a freelancer.",
    tags: ["brand", "branding", "identity", "positioning", "logo", "copy", "voice", "design"] },
  { name: "sales-outreach", domain: "communication", code: SALES_OUTREACH,
    description: "Draft a cold-email outreach campaign with an A/B subject test and a 3-step cadence; sending is via the notifications/business-email script after approval.",
    tags: ["sales", "outreach", "cold email", "campaign", "a/b test", "lead gen", "email"] },
  { name: "customer-retention", domain: "strategy", code: CUSTOMER_RETENTION,
    description: "Churn analysis, a win-back campaign, and a simple loyalty structure — drafts campaigns and points spend where it compounds.",
    tags: ["retention", "churn", "win back", "loyalty", "repeat customers", "lifecycle", "strategy"] },
];

/** Minimal structural view of a SkillLibrary for seeding — avoids importing the class (and its
 *  cloudflare:workers dep) into pure/testable callers. */
export interface SeedableLibrary {
  exists(name: string): Promise<boolean>;
  create(input: { name: string; code?: string; metadata: { description: string; domain: string; requires_tier: number; tags?: string[] } }): Promise<unknown>;
}

/**
 * Seed the six scaling skills into a space's (or template's) skill library. Idempotent — skips a
 * skill that already exists (so a re-provision or a builder's fork isn't clobbered). Best-effort per
 * skill: one failure never aborts the rest or the provision. Returns the names actually created.
 */
export async function seedScalingSkills(library: SeedableLibrary): Promise<string[]> {
  const created: string[] = [];
  for (const skill of LAUNCHPAD_SCALING_SKILLS) {
    try {
      if (await library.exists(skill.name)) continue;
      await library.create({
        name: skill.name,
        code: skill.code.trim(),
        metadata: { description: skill.description, domain: skill.domain, requires_tier: 2, tags: skill.tags },
      });
      created.push(skill.name);
    } catch {
      /* best-effort — a single skill failing must not abort provisioning */
    }
  }
  return created;
}
