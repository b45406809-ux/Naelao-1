// Phase 4 (money): the end user's own personal-plan tier — dependency-free (mirrors models.ts's
// own "no circular import" discipline, since this is imported by both the spaces worker and any
// frontend that wants to render limits/prices without pulling in the whole billing-core surface).
//
// SCOPE: this gates two things per the plan's own decision — how many businesses a signed-in
// end user can OWN under one product, and whether they may invite others into a business they
// own. It does NOT replace the existing business_subscriptions (the business as a whole funds
// its own team) or credit-pack (personal balance top-up) mechanisms — both of those already exist
// and are untouched; this is the third, previously-missing leg the plan called "personal plan
// gates how many businesses a user can create and whether others may join."

export type PersonalPlanTier = "free" | "plus";

export interface PersonalPlanLimits {
  /** How many businesses this tier lets a user OWN under one product, before combining with the
   *  product's own configured abuse ceiling (SpaceTypeProductConfig.maxBusinessesPerEndUser). */
  maxBusinessesOwned: number;
  /** Whether a business this user owns may issue invites for others to join it. */
  canInviteOthers: boolean;
}

export const PERSONAL_PLAN_LIMITS: Record<PersonalPlanTier, PersonalPlanLimits> = {
  free: { maxBusinessesOwned: 3, canInviteOthers: false },
  plus: { maxBusinessesOwned: 25, canInviteOthers: true },
};

export function isPersonalPlanTier(value: unknown): value is PersonalPlanTier {
  return value === "free" || value === "plus";
}

/**
 * Combine a user's personal-plan tier with the product's own configured ceiling
 * (maxBusinessesPerEndUser, default 10 — see business-create.ts). The PRODUCT ceiling is always
 * the outer bound a builder chose (an abuse/DoS cap, not a monetization lever) — a personal plan
 * can only ever narrow a free-tier user's OWN slice of it, never widen it beyond what the builder
 * allowed. 'plus' removes that narrowing and lets the user use the full product ceiling.
 */
export function resolveEffectiveBusinessLimit(tier: PersonalPlanTier, productCeiling: number): number {
  if (tier === "plus") return productCeiling;
  return Math.min(productCeiling, PERSONAL_PLAN_LIMITS.free.maxBusinessesOwned);
}

export function canPersonalPlanInvite(tier: PersonalPlanTier): boolean {
  return PERSONAL_PLAN_LIMITS[tier].canInviteOthers;
}
