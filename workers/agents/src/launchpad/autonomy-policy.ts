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

/** Apply a recognized bootstrap choice to the runtime policy endpoint. Keep the network
 * operation here so the compiler and fail-closed behavior can be tested without a full
 * Cloudflare Worker environment. */
export async function applyOnboardingAutonomyPolicy(input: {
  options: readonly string[] | undefined;
  answer: unknown;
  policyUrl: string;
  headers: Record<string, string>;
  fetch: (request: Request) => Promise<Response>;
}): Promise<{ configured: boolean; applied: boolean }> {
  const policy = onboardingAutonomyPolicy(input.options, input.answer);
  if (!policy) return { configured: false, applied: true };
  try {
    const response = await input.fetch(new Request(input.policyUrl, {
      method: "PATCH",
      headers: { ...input.headers, "content-type": "application/json" },
      body: JSON.stringify(policy),
    }));
    return { configured: true, applied: response.ok };
  } catch {
    return { configured: true, applied: false };
  }
}
