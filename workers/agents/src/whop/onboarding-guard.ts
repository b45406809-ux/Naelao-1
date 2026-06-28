/**
 * Onboarding niche guardrail (§11 / WG-32).
 *
 * §11 forbids trading-signal and betting/gambling-pick sub-niches — unlicensed
 * financial-advice and gambling-promotion exposure isn't worth the TAM — but the
 * spec gives no enforcement mechanism. This is it: a pure deny-list screen run
 * against the product name + description BEFORE a Whop product is ever created.
 * The onboarding route layers `moderateText()` on top for general content safety.
 *
 * Deliberately dependency-free so it is unit-testable.
 */

// Word-boundary patterns for the explicitly out-of-scope sub-niches. Kept narrow
// on purpose: this blocks the categories §11 names, not legitimate finance tools.
const DENIED_NICHE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\btrading\s*signals?\b/i, reason: "trading signals" },
  { pattern: /\bsignal\s*group\b/i, reason: "signal group" },
  { pattern: /\b(forex|crypto)\s*signals?\b/i, reason: "forex/crypto signals" },
  { pattern: /\bbetting\s*(picks?|tips?)\b/i, reason: "betting picks" },
  { pattern: /\b(sports?\s*betting|gambling)\b/i, reason: "sports betting / gambling" },
  { pattern: /\b(parlay|parlays|handicapper)\b/i, reason: "sports gambling" },
  { pattern: /\bpump\s*(and|&)?\s*dump\b/i, reason: "pump-and-dump" },
  { pattern: /\b(guaranteed|risk[-\s]?free)\s+(returns?|profits?|income)\b/i, reason: "guaranteed-returns claim" },
];

export interface NicheScreenResult {
  allowed: boolean;
  reason?: string;
}

/** Screen a proposed product against the §11 deny-list. Pure, case-insensitive. */
export function screenNiche(productName: string, description: string): NicheScreenResult {
  const haystack = `${productName}\n${description}`;
  for (const { pattern, reason } of DENIED_NICHE_PATTERNS) {
    if (pattern.test(haystack)) {
      return { allowed: false, reason: `Out-of-scope niche: ${reason} (§11 guardrail)` };
    }
  }
  return { allowed: true };
}
