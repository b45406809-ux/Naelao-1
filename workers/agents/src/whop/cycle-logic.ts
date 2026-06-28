/**
 * Pure cycle-logic helpers for the Whop Businesses script engine.
 *
 * Deliberately free of any `cloudflare:workers` import so it can be unit-tested in a
 * plain Node/vitest environment. BusinessDO imports these; tests import these.
 */

// ── Niche constants (hardcoded for the one template — no config system) ───────
export const DAILY_ACTION_CAP = 3;             // max published actions / 24h (WG-17)
export const BREAKER_THRESHOLD = 5;            // consecutive Whop failures before opening (WG-14)
export const BREAKER_COOLDOWN_MS = 5 * 60_000; // breaker stays open 5 min, then half-open
export const DEMOTE_STABILITY = 0.5;           // below this, excluded from Level-1 (WG-31)
export const DEMOTE_RECENT_PATCHES = 3;        // >= this many patches in last 10 runs → demote

const RECENT_PATCH_WINDOW_MS = 10 * 86400_000; // "recent" = last 10 days

export interface PatchEntry {
  version: number;
  reason: string;
  timestamp: number;
  type: string;
}

export interface StabilityInput {
  success_count: number;
  failure_count: number;
  patch_history: PatchEntry[];
}

/** stability = (success / total) × (1 / (1 + recent_patches)). */
export function computeStability(entry: StabilityInput, now: number = Date.now()): number {
  const total = entry.success_count + entry.failure_count;
  if (total === 0) return 1.0;
  const recentPatches = entry.patch_history.filter(p => p.timestamp > now - RECENT_PATCH_WINDOW_MS).length;
  return (entry.success_count / total) * (1 / (1 + recentPatches));
}

/**
 * Auto-demotion signal (WG-31): a script with a falling success rate or frequent
 * recent patches must not keep running at Level 1 just because it's cheap.
 */
export function isDemoted(
  entry: StabilityInput & { stability_score: number },
  now: number = Date.now(),
): boolean {
  if (entry.success_count + entry.failure_count === 0) return false; // unproven, not demoted
  if (entry.stability_score < DEMOTE_STABILITY) return true;
  const recentPatches = entry.patch_history.filter(p => p.timestamp > now - RECENT_PATCH_WINDOW_MS).length;
  return recentPatches >= DEMOTE_RECENT_PATCHES;
}

/** Deterministic structural fingerprint — FNV-1a 32-bit over sorted keys (not values). */
export function structuralFingerprint(snapshot: Record<string, unknown>): string {
  const structural = Object.keys(snapshot).sort().join(",");
  let h = 0x811c9dc5;
  for (let i = 0; i < structural.length; i++) {
    h ^= structural.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Token → cents rate table (per million tokens), keyed by model family (WG-21). */
export function modelRateCents(model: string): { in: number; out: number } {
  if (model.includes("haiku")) return { in: 80, out: 400 };    // $0.80 / $4.00 per Mtok
  if (model.includes("opus")) return { in: 1500, out: 7500 };  // $15 / $75 per Mtok
  return { in: 300, out: 1500 };                                // sonnet default
}

/** Cost in cents for a single model call. */
export function costCents(model: string, inputTokens: number, outputTokens: number): number {
  const rate = modelRateCents(model);
  return (inputTokens / 1_000_000) * rate.in + (outputTokens / 1_000_000) * rate.out;
}

/** Daily-cap predicate (WG-17): is a publish action over the cap? */
export function overDailyCap(publishCountLast24h: number, cap: number = DAILY_ACTION_CAP): boolean {
  return publishCountLast24h >= cap;
}

/**
 * Promotion criteria (cross-agent learning): a script is worth spreading to every
 * other agent only once it's genuinely proven on the business that derived it.
 */
export function shouldPromote(entry: { stability_score: number; success_count: number }): boolean {
  return entry.stability_score >= 0.8 && entry.success_count >= 5;
}

export type AutonomyTier = 1 | 2 | 3;
export type PublishDecision = "publish" | "draft_for_approval" | "blocked_moderation" | "deferred_cap";

/**
 * Decide what happens to a freshly generated community post. Composes the two
 * independent axes from the spec: moderation (WG-30, content safety) and autonomy
 * (§07, how much the agent may do unattended) plus the daily cap (WG-17).
 *
 *  - unsafe content        → blocked, regardless of tier
 *  - Tier 1 (Draft)        → queue a draft for human approval, never auto-publish
 *  - Tier 2/3 over the cap → defer to a later cycle
 *  - otherwise             → publish
 */
export function decidePublish(tier: AutonomyTier, contentAllowed: boolean, overCap: boolean): PublishDecision {
  if (!contentAllowed) return "blocked_moderation";
  if (tier === 1) return "draft_for_approval";
  if (overCap) return "deferred_cap";
  return "publish";
}
