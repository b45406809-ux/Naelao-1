/**
 * Host-action allow-list — the concrete `whopBusinessesV1` business-logic module.
 *
 * This is the fixed set of actions a Whop business may take in a nightly cycle.
 * Stored scripts are NEVER eval'd (WG-02): a script's `name` selects one of these
 * host actions, and the cycle's params are passed in. Anything not in this table
 * cannot run at Level 1 — it falls through to live reasoning (Level 4).
 *
 * Each action is a thin, typed wrapper over the real Whop client (`./client.ts`).
 * The DO orchestrator (BusinessDO) applies the gates around these calls —
 * autonomy tier, output moderation, daily cap, idempotency — based on `kind`.
 */

import {
  type WhopClientConfig,
  observeWhopBusiness,
  postCommunityUpdate,
  getCommunityActivity,
  getRevenueMetrics,
  updateWhopProductVisibility,
} from "./client.js";

// ── Action kinds drive which gates BusinessDO applies ─────────────────────────
//  observe  — read-only snapshot of the whole business
//  read     — read-only metric/activity pull
//  publish  — emits content to the community (→ moderation + daily cap)
//  mutate   — changes product state (visibility/pricing) (→ autonomy gate)
//  internal — no Whop side effect (drafts, logging)
export type HostActionKind = "observe" | "read" | "publish" | "mutate" | "internal";

export interface HostActionContext {
  whop: WhopClientConfig;
  productId: string;
  cycleId: string;
}

export interface HostActionResult {
  success: boolean;
  output: string;
  /** Structured data for the outcome log / baseline (revenue, engagement, etc.). */
  data?: Record<string, unknown>;
}

export interface HostAction {
  kind: HostActionKind;
  /** For publish actions, the params key holding the user-facing content to moderate. */
  contentParam?: string;
  run(ctx: HostActionContext, params: Record<string, unknown>): Promise<HostActionResult>;
}

function str(params: Record<string, unknown>, key: string, fallback = ""): string {
  const v = params[key];
  return typeof v === "string" ? v : fallback;
}

export const HOST_ACTIONS: Record<string, HostAction> = {
  // ── Observe: full structural snapshot (revenue + activity + visibility) ──────
  observe_whop_snapshot: {
    kind: "observe",
    async run(ctx) {
      const snap = await observeWhopBusiness(ctx.whop, ctx.productId);
      return {
        success: true,
        output: `Observed Whop product ${ctx.productId} (fingerprint ${snap.fingerprint})`,
        data: snap as unknown as Record<string, unknown>,
      };
    },
  },

  // ── Read: recent community activity ─────────────────────────────────────────
  check_community_engagement: {
    kind: "read",
    async run(ctx) {
      const activity = await getCommunityActivity(ctx.whop, ctx.productId, 10);
      const engagement = activity.posts.reduce((s, p) => s + p.likes + p.replies, 0);
      const top = [...activity.posts].sort((a, b) => (b.likes + b.replies) - (a.likes + a.replies))[0];
      return {
        success: true,
        output: `Engagement ${engagement} across ${activity.total} posts`,
        data: { total_posts: activity.total, engagement_score: engagement, top_post: top ?? null },
      };
    },
  },

  // ── Read: current revenue metrics ───────────────────────────────────────────
  check_revenue_delta: {
    kind: "read",
    async run(ctx) {
      const rev = await getRevenueMetrics(ctx.whop, ctx.productId);
      return {
        success: true,
        output: `Revenue ${rev.total_revenue} (24h ${rev.revenue_last_24h}), ${rev.subscriber_count} subs`,
        data: rev as unknown as Record<string, unknown>,
      };
    },
  },

  // ── Publish: post a content update to the community ─────────────────────────
  //  Content must be supplied in params (e.g. a pre-approved draft). Novel content
  //  generation is a Level-4 path, not Level 1 — L1 stays model-free by design.
  post_community_update: {
    kind: "publish",
    contentParam: "content",
    async run(ctx, params) {
      const content = str(params, "content");
      if (!content) {
        return { success: false, output: "post_community_update requires a 'content' param" };
      }
      const post = await postCommunityUpdate(ctx.whop, {
        product_id: ctx.productId,
        content,
        idempotency_key: `post:${ctx.cycleId}`,
      });
      return { success: true, output: `Posted community update ${post.id}`, data: { post_id: post.id } };
    },
  },

  // ── Internal: compose a welcome draft (no Whop write) ───────────────────────
  draft_welcome_post: {
    kind: "internal",
    async run(_ctx, params) {
      const topic = str(params, "topic", "getting the most out of the tool");
      const draft = `Welcome to the community! 🎉 This week we're covering: ${topic}. Reply with your biggest challenge and it'll be addressed in the next update.`;
      return { success: true, output: "Drafted welcome post (pending approval)", data: { draft, requires_approval: true } };
    },
  },

  // ── Mutate: set product visibility (autonomy-gated) ─────────────────────────
  update_product_visibility: {
    kind: "mutate",
    async run(ctx, params) {
      const visibility = str(params, "visibility") as "visible" | "hidden" | "archived";
      if (!["visible", "hidden", "archived"].includes(visibility)) {
        return { success: false, output: "update_product_visibility requires visibility: visible|hidden|archived" };
      }
      const product = await updateWhopProductVisibility(ctx.whop, ctx.productId, visibility, `visibility:${ctx.cycleId}`);
      return { success: true, output: `Set visibility=${product.visibility}`, data: { visibility: product.visibility } };
    },
  },

  // ── Internal: structured outcome capture (DO writes the row) ────────────────
  log_cycle_outcome: {
    kind: "internal",
    async run(ctx, params) {
      return {
        success: true,
        output: "Captured cycle outcome",
        data: {
          action_type: str(params, "action_type", "cycle"),
          action_detail: str(params, "action_detail"),
        },
      };
    },
  },
};

/** Publish action types — used by the daily-cap counter in BusinessDO. */
export const PUBLISH_ACTION_NAMES: readonly string[] = Object.entries(HOST_ACTIONS)
  .filter(([, a]) => a.kind === "publish")
  .map(([name]) => name);

export function getHostAction(name: string): HostAction | undefined {
  return HOST_ACTIONS[name];
}
