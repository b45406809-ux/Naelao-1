import type { AgentManifest } from "../manifest.js";

/**
 * Whop Businesses niche — expressed as DATA, not hardcoded engine logic.
 * The script-first engine + this manifest = a Whop-running agent. Swap the manifest
 * and the same engine runs a different niche.
 */
export const WHOP_MANIFEST: AgentManifest = {
  id: "whop-businesses-v1",
  kind: "niche",
  name: "Whop Businesses",
  description: "AI-built micro-tool + community, sold on Whop, run by a script-first agent loop.",
  cost_multiplier: 1,
  skills: ["observe-first", "community-post", "verify-landed", "pricing-guarded", "improve-tool"],
  capabilities: [
    "observe_whop_snapshot", "post_community_update", "check_community_engagement",
    "check_revenue_delta", "draft_welcome_post", "update_product_visibility", "log_cycle_outcome",
  ],
  instructions:
    "You run a Whop business: an AI-built micro-tool bundled with a support community. " +
    "Each night, observe real Whop state first, then take the single most useful action — " +
    "post useful content in brand voice, check engagement, or improve the tool. The tool must " +
    "demonstrably work before it's sold. No trading-signal, betting, or financial-advice niches.",
  seed_scripts: [
    {
      name: "observe_whop_snapshot",
      description: "Pull current Whop product state: revenue metrics, community activity, and product visibility",
      tier: 2,
      preconditions: ["whop_product_id is set", "whop API key available"],
      code: `
// Observe: fetch Whop product snapshot
const productId = state.whop_product_id;
const [metrics, posts, product] = await Promise.allSettled([
  whop.getRevenueMetrics(config, productId),
  whop.getCommunityActivity(config, productId, 5),
  whop.getWhopProduct(config, productId),
]);
return {
  revenue: metrics.status === 'fulfilled' ? metrics.value : null,
  recent_posts: posts.status === 'fulfilled' ? posts.value.posts : [],
  visibility: product.status === 'fulfilled' ? product.value.visibility : 'unknown',
  timestamp: Date.now(),
};`.trim(),
    },
    {
      name: "post_community_update",
      description: "Post a content update to the Whop community feed — value/tip/announcement",
      tier: 2,
      preconditions: ["autonomy_tier >= 2", "content param provided"],
      code: `
const content = params.content;
const idKey = \`post:\${cycleId}\`;
return whop.postCommunityUpdate(config, { product_id: state.whop_product_id, content, idempotency_key: idKey });`.trim(),
    },
    {
      name: "check_community_engagement",
      description: "Read recent community posts and surface reply/like count for the agent to act on",
      tier: 2,
      preconditions: ["whop_product_id is set"],
      code: `
const activity = await whop.getCommunityActivity(config, state.whop_product_id, 10);
const topPost = activity.posts.sort((a, b) => (b.likes + b.replies) - (a.likes + a.replies))[0];
return { total_posts: activity.total, top_post: topPost ?? null, engagement_score: activity.posts.reduce((s, p) => s + p.likes + p.replies, 0) };`.trim(),
    },
    {
      name: "check_revenue_delta",
      description: "Compare current revenue metrics against the last stored baseline and return delta",
      tier: 2,
      preconditions: ["whop_product_id is set"],
      code: `
const current = await whop.getRevenueMetrics(config, state.whop_product_id);
const baseline = state.revenue_baseline ?? current;
return { revenue_delta: current.total_revenue - (baseline.total_revenue ?? 0), subscriber_delta: current.subscriber_count - (baseline.subscriber_count ?? 0), current };`.trim(),
    },
    {
      name: "draft_welcome_post",
      description: "Draft a welcome post for new community members — queued for human review (Tier 1 safe)",
      tier: 2,
      preconditions: ["always allowed — Tier 1 safe"],
      code: `
const draft = \`Welcome to the community! 🎉 This week we're covering: \${params.topic}. Reply with your biggest challenge and I'll address it in the next update.\`;
return { draft, action: 'draft', requires_approval: true };`.trim(),
    },
    {
      name: "update_product_visibility",
      description: "Set the Whop product visibility (visible/hidden) — requires Tier 3 autonomy",
      tier: 2,
      preconditions: ["autonomy_tier >= 3", "visibility param provided"],
      code: `
const visibility = params.visibility;
const idKey = \`visibility:\${cycleId}\`;
return whop.updateWhopProductVisibility(config, state.whop_product_id, visibility, idKey);`.trim(),
    },
    {
      name: "log_cycle_outcome",
      description: "Write a structured outcome entry to the outcome_log after a completed cycle",
      tier: 1,
      preconditions: ["always safe — read-only DB write"],
      code: `
return { logged: true, entry: { cycle_id: cycleId, action_type: params.action_type, action_detail: params.action_detail ?? '', revenue_delta_24h: params.revenue_delta ?? null, engagement_delta_24h: params.engagement_delta ?? null, template_version: state.template_version ?? '1', timestamp: Date.now() } };`.trim(),
    },
  ],
};
