/**
 * Prebuilt skills + instructions for the Whop Businesses agent.
 *
 * Mirrors Project Think's `getSkills()` concept: a catalog of named capabilities,
 * each with a short instruction "playbook" the agent follows, auto-rendered into
 * the system prompt. These ship with the template (not authored by users) so the
 * agent starts competent instead of re-deriving how to run a Whop business each
 * night — and so its output isn't the generic, voiceless content that sank Polsia.
 *
 * Pure and dependency-free so it is unit-testable and reusable.
 */

export interface Skill {
  id: string;
  name: string;
  when_to_use: string;
  /** The instruction playbook the agent follows when this skill applies. */
  instructions: string;
  /** Host action(s) this skill drives (see whop/actions.ts), if any. */
  actions: string[];
  /** Minimum autonomy tier required to act on this skill unattended. */
  min_tier: 1 | 2 | 3;
}

export const SKILLS: Skill[] = [
  {
    id: "observe-first",
    name: "Observe before acting",
    when_to_use: "At the start of every cycle.",
    instructions:
      "Always ground decisions in the real, freshly-observed Whop state — never assume or invent metrics. If observation failed, do nothing this cycle and report it. (Polsia lost trust by acting on data it hadn't actually pulled.)",
    actions: ["observe_whop_snapshot", "check_revenue_delta", "check_community_engagement"],
    min_tier: 1,
  },
  {
    id: "community-post",
    name: "Write a useful community post",
    when_to_use: "When engagement is low or it's been >2 days since the last post, and the daily cap allows.",
    instructions:
      "Write one concrete, genuinely useful post in the business's brand voice. No hype, no income guarantees, no financial/investment advice. Reference something real from the observed activity. Specific beats generic — a real tip outperforms a motivational platitude.",
    actions: ["post_community_update", "draft_welcome_post"],
    min_tier: 2,
  },
  {
    id: "verify-landed",
    name: "Verify the action actually landed",
    when_to_use: "After any publish or mutate action.",
    instructions:
      "Re-observe and confirm the post/change actually appears in Whop before recording success. Never mark an action complete on optimism. (Polsia's top complaint was tasks marked done that never happened.)",
    actions: [],
    min_tier: 1,
  },
  {
    id: "pricing-guarded",
    name: "Adjust pricing only within bounds",
    when_to_use: "When revenue is flat and the business is Tier 3.",
    instructions:
      "Only change price inside the pre-set bound, one small step at a time, and never more often than allowed. Anything outside the bound requires human approval. Wrong prices are real money lost.",
    actions: ["update_product_visibility"],
    min_tier: 3,
  },
  {
    id: "improve-tool",
    name: "Improve the micro-tool",
    when_to_use: "When the tool's tests fail or users report it doesn't work.",
    instructions:
      "Regenerate or patch the tool's code, then build + test it in the Tier-5 container. Never deploy a version that hasn't passed its own tests — the tool must demonstrably work before anyone pays for it (§02).",
    actions: [],
    min_tier: 3,
  },
];

/** Skills available to the agent at a given autonomy tier. */
export function skillsForTier(tier: 1 | 2 | 3): Skill[] {
  return SKILLS.filter((s) => s.min_tier <= tier);
}

/** Render the skill catalog into a system-prompt section (Think-style). */
export function renderSkillsPrompt(tier: 1 | 2 | 3): string {
  const lines = skillsForTier(tier).map(
    (s) => `- ${s.name} (use when: ${s.when_to_use})\n  ${s.instructions}`,
  );
  return `You have the following prebuilt skills. Follow these instructions:\n${lines.join("\n")}`;
}
