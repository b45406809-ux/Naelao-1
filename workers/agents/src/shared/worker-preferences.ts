/**
 * Worker preference resolver (MS-23, decision D10). Pure: no I/O and no wiring into callers.
 *
 * The tightest setting wins per field across plan -> Space admin -> Project -> user.
 * Invalid numbers (NaN, infinite, non-integer, negative) are ignored for their layer and
 * reported in `sources.ignored`. Values outside an allowed range are clamped and reported
 * in `sources.clamped`.
 */

export const DEFAULT_WORKER_COUNT = 3;
export const ADMIN_WORKER_COUNT_MIN = 1;
export const ADMIN_WORKER_COUNT_MAX = 10;
export const DEFAULT_GOAL_CREDIT_CEILING = 200;

export type PreferenceLayer = "plan" | "space" | "project" | "user";

/** Limits an admin (Space) or a Project may set. Every field is optional. */
export interface WorkerPreferenceLimits {
  maxWorkers?: number;
  allowedModelTiers?: readonly string[];
  goalCreditCeiling?: number;
}

/** Platform plan limits. `maxWorkers` is required; the rest are optional platform layers. */
export interface WorkerPlanLimits {
  maxWorkers: number;
  allowedModelTiers?: readonly string[];
  goalCreditCeiling?: number;
}

/** Per-user preferences. A user may pick a worker count and a model tier, and lower the ceiling. */
export interface WorkerUserPreferences {
  workerCount?: number;
  preferredModelTier?: string;
  goalCreditCeiling?: number;
}

export interface WorkerPreferenceInput {
  planLimits: WorkerPlanLimits;
  spaceLimits?: WorkerPreferenceLimits;
  projectSettings?: WorkerPreferenceLimits;
  userPreferences?: WorkerUserPreferences;
  /** Relative cost per model tier (for example `{ economy: 1, standard: 4, premium: 15 }`). */
  modelTierCost: Readonly<Record<string, number>>;
}

export interface WorkerPreferenceSources {
  workerCount: "default" | PreferenceLayer;
  goalCreditCeiling: "default" | PreferenceLayer;
  /** `all-known` when no layer sets allowed tiers; `intersection` when at least one does. */
  allowedModelTiers: "all-known" | "intersection";
  preferredModelTier: "user" | "cheapest-allowed" | "none";
  /** Values that were clamped to a bound, for example `user.workerCount:9->3`. */
  clamped: string[];
  /** Values or entries that were ignored, for example `space.maxWorkers:invalid`. */
  ignored: string[];
}

export interface ResolvedWorkerPreferences {
  workerCount: number;
  /** Allowed tiers, cheapest first. Empty means only the host default applies. */
  allowedModelTiers: string[];
  /** Null only when no tier is allowed. */
  preferredModelTier: string | null;
  /** Allowed tiers no more expensive than the preferred tier, most expensive first. */
  fallbackTiers: string[];
  goalCreditCeiling: number;
  sources: WorkerPreferenceSources;
}

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  isNonNegativeInteger(value) && value > 0;

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

function knownTierCosts(
  raw: Readonly<Record<string, number>>,
  ignored: string[],
): Map<string, number> {
  const costs = new Map<string, number>();
  for (const [tier, cost] of Object.entries(raw)) {
    if (tier.length > 0 && typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      costs.set(tier, cost);
    } else {
      ignored.push(`modelTierCost.${tier}:invalid`);
    }
  }
  return costs;
}

export function resolveWorkerPreferences(input: WorkerPreferenceInput): ResolvedWorkerPreferences {
  const clamped: string[] = [];
  const ignored: string[] = [];
  const costs = knownTierCosts(input.modelTierCost, ignored);

  // Worker count. The plan is the platform ceiling. An invalid plan value fails closed to 1.
  let maxWorkers: number;
  let maxWorkersLayer: PreferenceLayer = "plan";
  const planWorkers = input.planLimits.maxWorkers;
  if (isNonNegativeInteger(planWorkers)) {
    maxWorkers = clampInt(planWorkers, ADMIN_WORKER_COUNT_MIN, Number.MAX_SAFE_INTEGER);
    if (maxWorkers !== planWorkers) clamped.push(`plan.maxWorkers:${planWorkers}->${maxWorkers}`);
  } else {
    maxWorkers = ADMIN_WORKER_COUNT_MIN;
    ignored.push("plan.maxWorkers:invalid");
  }

  // Space admin max: clamped to 1..10 and to the plan limit.
  const spaceWorkers = input.spaceLimits?.maxWorkers;
  if (spaceWorkers !== undefined) {
    if (!isNonNegativeInteger(spaceWorkers)) {
      ignored.push("space.maxWorkers:invalid");
    } else {
      const bound = clampInt(spaceWorkers, ADMIN_WORKER_COUNT_MIN, Math.min(ADMIN_WORKER_COUNT_MAX, maxWorkers));
      if (bound !== spaceWorkers) clamped.push(`space.maxWorkers:${spaceWorkers}->${bound}`);
      if (bound < maxWorkers) {
        maxWorkers = bound;
        maxWorkersLayer = "space";
      }
    }
  }

  // Project: can only tighten, clamped to at least 1 and to the current effective maximum.
  const projectWorkers = input.projectSettings?.maxWorkers;
  if (projectWorkers !== undefined) {
    if (!isNonNegativeInteger(projectWorkers)) {
      ignored.push("project.maxWorkers:invalid");
    } else {
      const bound = clampInt(projectWorkers, ADMIN_WORKER_COUNT_MIN, maxWorkers);
      if (bound !== projectWorkers) clamped.push(`project.maxWorkers:${projectWorkers}->${bound}`);
      if (bound < maxWorkers) {
        maxWorkers = bound;
        maxWorkersLayer = "project";
      }
    }
  }

  let workerCount: number;
  let workerCountSource: WorkerPreferenceSources["workerCount"];
  const userWorkers = input.userPreferences?.workerCount;
  if (userWorkers !== undefined && !isNonNegativeInteger(userWorkers)) {
    ignored.push("user.workerCount:invalid");
  }
  if (userWorkers !== undefined && isNonNegativeInteger(userWorkers)) {
    workerCount = clampInt(userWorkers, ADMIN_WORKER_COUNT_MIN, maxWorkers);
    if (workerCount !== userWorkers) clamped.push(`user.workerCount:${userWorkers}->${workerCount}`);
    workerCountSource = "user";
  } else if (DEFAULT_WORKER_COUNT <= maxWorkers) {
    workerCount = DEFAULT_WORKER_COUNT;
    workerCountSource = "default";
  } else {
    workerCount = maxWorkers;
    workerCountSource = maxWorkersLayer;
  }

  // Goal credit ceiling. Admin and plan layers set it (tightest wins); default 200 when none does.
  let ceiling: number | undefined;
  let ceilingSource: WorkerPreferenceSources["goalCreditCeiling"] = "default";
  const limitLayers: Array<[PreferenceLayer, WorkerPreferenceLimits | WorkerPlanLimits | undefined]> = [
    ["plan", input.planLimits],
    ["space", input.spaceLimits],
    ["project", input.projectSettings],
  ];
  for (const [layer, limits] of limitLayers) {
    const raw = limits?.goalCreditCeiling;
    if (raw === undefined) continue;
    if (!isPositiveInteger(raw)) {
      ignored.push(`${layer}.goalCreditCeiling:invalid`);
      continue;
    }
    if (ceiling === undefined || raw < ceiling) {
      ceiling = raw;
      ceilingSource = layer;
    }
  }
  if (ceiling === undefined) ceiling = DEFAULT_GOAL_CREDIT_CEILING;

  // A user may only lower the ceiling.
  const userCeiling = input.userPreferences?.goalCreditCeiling;
  if (userCeiling !== undefined) {
    if (!isPositiveInteger(userCeiling)) {
      ignored.push("user.goalCreditCeiling:invalid");
    } else if (userCeiling <= ceiling) {
      ceiling = userCeiling;
      ceilingSource = "user";
    } else {
      clamped.push(`user.goalCreditCeiling:${userCeiling}->${ceiling}`);
    }
  }

  // Allowed model tiers: intersection of the layers that set them, or every known tier.
  const knownTiers = new Set(costs.keys());
  let allowed: Set<string> | undefined;
  for (const [layer, limits] of [
    ["plan", input.planLimits],
    ["space", input.spaceLimits],
    ["project", input.projectSettings],
  ] as const) {
    const tiers = limits?.allowedModelTiers;
    if (tiers === undefined) continue;
    if (!Array.isArray(tiers)) {
      ignored.push(`${layer}.allowedModelTiers:invalid`);
      continue;
    }
    const layerSet = new Set<string>();
    for (const tier of tiers) {
      if (typeof tier === "string" && knownTiers.has(tier)) layerSet.add(tier);
      else ignored.push(`${layer}.allowedModelTiers:unknown-tier`);
    }
    allowed = allowed === undefined
      ? layerSet
      : new Set([...allowed].filter((tier) => layerSet.has(tier)));
  }
  const allowedSet = allowed ?? knownTiers;
  const allowedModelTiers = [...allowedSet].sort(
    (a, b) => (costs.get(a) ?? 0) - (costs.get(b) ?? 0) || a.localeCompare(b),
  );

  // Preferred tier: the user's pick if allowed, otherwise the cheapest allowed tier.
  let preferredModelTier: string | null = null;
  let preferredSource: WorkerPreferenceSources["preferredModelTier"] = "none";
  const userTier = input.userPreferences?.preferredModelTier;
  if (allowedModelTiers.length > 0) {
    if (typeof userTier === "string" && allowedSet.has(userTier)) {
      preferredModelTier = userTier;
      preferredSource = "user";
    } else {
      if (userTier !== undefined) ignored.push("user.preferredModelTier:not-allowed");
      preferredModelTier = allowedModelTiers[0] ?? null;
      preferredSource = "cheapest-allowed";
    }
  } else if (userTier !== undefined) {
    ignored.push("user.preferredModelTier:no-allowed-tiers");
  }

  // Fallbacks never cost more than the preferred tier. Most expensive first, cheapest last.
  const fallbackTiers: string[] = [];
  if (preferredModelTier !== null) {
    const preferredCost = costs.get(preferredModelTier) ?? 0;
    for (const tier of allowedModelTiers) {
      if (tier !== preferredModelTier && (costs.get(tier) ?? Infinity) <= preferredCost) {
        fallbackTiers.push(tier);
      }
    }
    fallbackTiers.sort((a, b) => (costs.get(b) ?? 0) - (costs.get(a) ?? 0) || a.localeCompare(b));
  }

  return {
    workerCount,
    allowedModelTiers,
    preferredModelTier,
    fallbackTiers,
    goalCreditCeiling: ceiling,
    sources: {
      workerCount: workerCountSource,
      goalCreditCeiling: ceilingSource,
      allowedModelTiers: allowed === undefined ? "all-known" : "intersection",
      preferredModelTier: preferredSource,
      clamped,
      ignored,
    },
  };
}
