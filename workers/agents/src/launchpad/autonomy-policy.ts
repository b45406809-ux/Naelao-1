/** Translate the three ordered autonomy choices used by Launchpad onboarding into the
 * authoritative Space Assistant policy. Templates can phrase each choice for their domain, but
 * keep the order stable: ask first, routine work, then autonomous within enforced limits. */
export function onboardingAutonomyPolicy(
  options: readonly string[] | undefined,
  answer: unknown
): { approval_mode: "always_ask" | "yolo"; auto_approved_actions?: string[] } | null {
  if (!options || options.length !== 3 || typeof answer !== "string") return null;
  const selected = options.indexOf(answer);
  if (selected === 0) return { approval_mode: "always_ask", auto_approved_actions: [] };
  if (selected === 1) return { approval_mode: "always_ask" };
  if (selected === 2) return { approval_mode: "yolo" };
  return null;
}
