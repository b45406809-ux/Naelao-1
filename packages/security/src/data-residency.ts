export type DataJurisdiction = "eu";

const scopedEnvironments = new WeakSet<object>();

/**
 * Resolve the deployment's immutable storage jurisdiction.
 *
 * An unset value preserves the existing global deployment. Any configured value
 * other than `eu` fails closed: silently ignoring a typo would create objects in
 * the unrestricted namespace.
 */
export function parseDataJurisdiction(value: string | undefined): DataJurisdiction | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (value === "eu") return value;
  throw new Error(`Unsupported DATA_JURISDICTION '${value}'. Supported values: eu`);
}

export function jurisdictionalNamespace<T extends DurableObjectNamespace>(
  namespace: T,
  configured: string | undefined,
): T {
  const jurisdiction = parseDataJurisdiction(configured);
  return jurisdiction ? namespace.jurisdiction(jurisdiction) as T : namespace;
}

/** Scope named Durable Object bindings in-place at a worker boundary. */
export function applyDurableObjectJurisdiction<
  T extends Record<string, unknown>,
  K extends keyof T,
>(env: T, configured: string | undefined, bindings: readonly K[]): void {
  const jurisdiction = parseDataJurisdiction(configured);
  if (!jurisdiction) return;
  if (scopedEnvironments.has(env)) return;
  for (const binding of bindings) {
    const namespace = env[binding] as DurableObjectNamespace | undefined;
    if (namespace) env[binding] = namespace.jurisdiction(jurisdiction) as T[K];
  }
  scopedEnvironments.add(env);
}
