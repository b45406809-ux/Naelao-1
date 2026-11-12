export interface DevelopmentCheckoutPolicy {
  environment: string;
  allowDevCheckouts?: string | undefined;
}

const LOCAL_ENVIRONMENTS = new Set(["development", "local", "test"]);

/** A simulated checkout is available only with an explicit opt-in in a local/test environment. */
export function isDevelopmentCheckoutAllowed(policy: DevelopmentCheckoutPolicy): boolean {
  return policy.allowDevCheckouts === "true" && LOCAL_ENVIRONMENTS.has(policy.environment.trim().toLowerCase());
}
