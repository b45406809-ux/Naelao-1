export type PlanTier = "FREE" | "STARTER" | "PRO" | "ENTERPRISE";

export interface PlanConfiguration {
  tier: PlanTier;
  monthlyPriceUsd: number;
  monthlyCredits: number;
  maxParallelWorkers: number;
  byokOnly: boolean;
}

export const PLANS: Readonly<Record<PlanTier, PlanConfiguration>> = Object.freeze({
  FREE: { tier: "FREE", monthlyPriceUsd: 0, monthlyCredits: 0, maxParallelWorkers: 1, byokOnly: true },
  STARTER: { tier: "STARTER", monthlyPriceUsd: 29, monthlyCredits: 1_200, maxParallelWorkers: 1, byokOnly: false },
  PRO: { tier: "PRO", monthlyPriceUsd: 99, monthlyCredits: 4_500, maxParallelWorkers: 8, byokOnly: false },
  ENTERPRISE: { tier: "ENTERPRISE", monthlyPriceUsd: 299, monthlyCredits: 15_000, maxParallelWorkers: 32, byokOnly: false },
});

export function normalizePlanTier(value: string | null | undefined): PlanTier {
  const tier = value?.toUpperCase();
  if (tier === "PRO" || tier === "BUSINESS") return "PRO";
  if (tier === "ENTERPRISE") return "ENTERPRISE";
  if (tier === "STARTER" || tier === "GROWTH") return "STARTER";
  return "FREE";
}

export function clampPlanParallelism(plan: string, requested: number): number {
  const safeRequested = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1;
  return Math.min(safeRequested, PLANS[normalizePlanTier(plan)].maxParallelWorkers);
}
