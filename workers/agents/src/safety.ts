/**
 * Platform safety floor — template-AGNOSTIC.
 *
 * The Whop-Businesses niche guard (whop/onboarding-guard.ts) is specific to one
 * template. The moment a user can describe ANY business — the custom / no-template
 * (Level 4) path — those niche-specific guardrails no longer cover the request.
 *
 * This is the general floor that must hold regardless of which template (or no
 * template) a request came through: it blocks the genuinely dangerous and regulated
 * categories — financial advice, gambling, regulated professions, scams — before the
 * agent does anything. It is NOT a generic business-builder; it's the small safety
 * net the advisor flagged as the prerequisite for ever exposing a custom path.
 *
 * Pure and dependency-free so it is unit-testable and reused everywhere.
 */

export type SafetyCategory =
  | "financial_advice"
  | "gambling"
  | "regulated_profession"
  | "controlled_goods"
  | "scam_or_guarantee"
  | "adult";

const FLOOR: Array<{ category: SafetyCategory; pattern: RegExp }> = [
  // Financial / investment advice & signals
  { category: "financial_advice", pattern: /\b(invest(ment|ing)?\s+advice|financial\s+advice|stock\s+tips?|trading\s+signals?|forex|crypto\s+signals?|portfolio\s+management|securities)\b/i },
  // Gambling / betting
  { category: "gambling", pattern: /\b(gambling|casino|sports?\s*betting|betting\s*(picks?|tips?)|parlay|parlays|handicapper|lottery|poker\s+for\s+money)\b/i },
  // Regulated professions / advice
  { category: "regulated_profession", pattern: /\b(medical\s+advice|diagnos(e|is)|prescri(be|ption)|legal\s+advice|practice\s+law|tax\s+advice|immigration\s+advice)\b/i },
  // Controlled / dangerous goods
  { category: "controlled_goods", pattern: /\b(firearms?|weapons?|ammunition|explosives?|illegal\s+drugs?|controlled\s+substances?|counterfeit)\b/i },
  // Scams / guaranteed income schemes
  { category: "scam_or_guarantee", pattern: /\b(guaranteed\s+(returns?|profits?|income)|get\s+rich\s+quick|ponzi|pyramid\s+scheme|pump\s*(and|&)?\s*dump|risk[-\s]?free\s+(money|profit))\b/i },
  // Adult
  { category: "adult", pattern: /\b(porn|pornographic|escort|adult\s+content|onlyfans\s+management)\b/i },
];

export interface SafetyResult {
  allowed: boolean;
  category?: SafetyCategory;
  reason?: string;
}

/**
 * The template-agnostic safety floor. Run on any business description / goal — the
 * Whop template, a custom business, or a Level-4 goal — BEFORE acting.
 */
export function safetyFloor(text: string): SafetyResult {
  for (const { category, pattern } of FLOOR) {
    if (pattern.test(text)) {
      return { allowed: false, category, reason: `Blocked category: ${category.replace(/_/g, " ")} (platform safety floor)` };
    }
  }
  return { allowed: true };
}
