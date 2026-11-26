/**
 * MS-25 / decision D10: apply a goal's snapshotted worker preferences to the model the host's
 * routing already chose. Pure (no I/O). `resolveWorkerModel` / `selectWorkerModel` stay the only
 * routing; this only narrows or re-targets their result.
 *
 * TIER -> MODEL MAPPING. A "tier" is the billing-core cost tier (`economy` < `standard` < `premium`)
 * that `model-benchmarks.ts` already assigns to every `ALLOWED_MODELS` entry, exposed as
 * `costRankForModel` (1..3). A model that is not in that table (for example an OpenRouter pool card)
 * is `standard`, the same default `costRankForModel` uses. The tier of a model is therefore
 * `TIERS[costRankForModel(model) - 1]` and a tier's cost for the resolver is its rank.
 *
 * Within a tier the concrete model is chosen from `ALLOWED_MODELS` of the SAME provider family as the
 * host-routed model (OpenRouter, a compat provider such as `google-ai-studio`, or the platform
 * gateway), so a preference can never move work to another provider, payer or credential. Private,
 * local, custom and BYOK routes are never re-targeted. Every candidate also stays within the effort
 * ceiling (`escalationCeiling`), which remains the hard cost limit.
 *
 * Rules:
 *  - User did NOT pick a tier (`sources.preferredModelTier !== "user"`): keep the host's model when
 *    its tier is allowed (or the allowed set is empty). Otherwise substitute an allowed tier, preferring
 *    the most expensive one that is no more expensive than the host's choice, else the cheapest allowed.
 *  - User picked an allowed tier: use it; when no model of that tier is available on the route fall
 *    back only to `fallbackTiers` (never more expensive), most expensive first.
 */
import { ALLOWED_MODELS, DEFAULT_WORKING_MODEL, OPENROUTER_WORKING_MODEL, costRankForModel, escalationCeiling, type EffortLevel } from "@naelao/billing-core";
import { isCompatProviderModel } from "../shared/ai-client.js";
import type { WorkerModelResolution } from "./worker-model-routing.js";

export const WORKER_MODEL_TIERS = ["economy", "standard", "premium"] as const;
export type WorkerModelTier = (typeof WORKER_MODEL_TIERS)[number];
/** Relative cost per tier, as handed to `resolveWorkerPreferences` (`modelTierCost`). */
export const WORKER_MODEL_TIER_COST: Readonly<Record<string, number>> = { economy: 1, standard: 2, premium: 3 };

export function workerModelTier(model: string): WorkerModelTier {
  return WORKER_MODEL_TIERS[Math.min(WORKER_MODEL_TIERS.length, Math.max(1, costRankForModel(model))) - 1]!;
}

const providerOf = (model: string): string =>
  model.startsWith("openrouter/") ? "openrouter" : isCompatProviderModel(model) ? model.split("/")[0]! : "platform";

/** The model-relevant part of a stored goal snapshot. */
export interface WorkerModelPolicy {
  allowedModelTiers: readonly string[];
  preferredModelTier: string | null;
  fallbackTiers: readonly string[];
  /** Resolver `sources.preferredModelTier`: only `"user"` means the user actually chose a tier. */
  preferredSource: string;
}

function modelForTier(tier: string, hostModel: string, ceiling: number): string | undefined {
  const provider = providerOf(hostModel);
  const candidates = ALLOWED_MODELS.filter(model => workerModelTier(model) === tier && providerOf(model) === provider
    && costRankForModel(model) <= ceiling);
  return candidates.find(model => model === hostModel) ?? candidates.find(model => model === DEFAULT_WORKING_MODEL)
    ?? candidates.find(model => model === OPENROUTER_WORKING_MODEL) ?? candidates[0];
}

export function applyWorkerModelTierPolicy(input: {
  resolution: WorkerModelResolution;
  policy: WorkerModelPolicy;
  plannerModel: string;
  effort: EffortLevel;
  privateRoute: boolean;
  /** True for BYOK/custom/local planner routes whose model is the authorized one. */
  routeLocked?: boolean;
}): WorkerModelResolution {
  const host = input.resolution;
  const { policy } = input;
  if (input.privateRoute || input.routeLocked || host.model.startsWith("local/") || host.model.startsWith("custom/")) return host;
  const ceiling = escalationCeiling(input.plannerModel, input.effort);
  const hostTier = workerModelTier(host.model);
  const hostCost = WORKER_MODEL_TIER_COST[hostTier] ?? 2;
  const allowed = new Set(policy.allowedModelTiers);
  const choose = (tiers: readonly string[], reason: string): WorkerModelResolution | undefined => {
    for (const tier of tiers) {
      const model = modelForTier(tier, host.model, ceiling);
      if (model) return model === host.model ? host : { model, downgraded: true, reason };
    }
    return undefined;
  };
  const fail = (): never => { throw new Error("worker_model_tier_unavailable"); };

  if (policy.preferredSource === "user" && policy.preferredModelTier && allowed.has(policy.preferredModelTier)) {
    const order = [policy.preferredModelTier, ...policy.fallbackTiers];
    // Fallback tiers are never more expensive than the user's pick; guard anyway.
    const pickCost = WORKER_MODEL_TIER_COST[policy.preferredModelTier] ?? Infinity;
    const safe = order.filter(tier => (WORKER_MODEL_TIER_COST[tier] ?? Infinity) <= pickCost && allowed.has(tier));
    return choose(safe, `Worker preferences selected the '${policy.preferredModelTier}' model tier (or an allowed, not more expensive fallback).`)
      ?? (safe.includes(hostTier) ? host : fail());
  }

  if (allowed.size === 0 || allowed.has(hostTier)) return host;
  const tiers = [...allowed].sort((a, b) => (WORKER_MODEL_TIER_COST[a] ?? Infinity) - (WORKER_MODEL_TIER_COST[b] ?? Infinity));
  const notMoreExpensive = tiers.filter(tier => (WORKER_MODEL_TIER_COST[tier] ?? Infinity) <= hostCost).reverse();
  const pricier = tiers.filter(tier => (WORKER_MODEL_TIER_COST[tier] ?? Infinity) > hostCost);
  return choose([...notMoreExpensive, ...pricier], "Worker preferences restricted the model to the allowed tiers.") ?? fail();
}
