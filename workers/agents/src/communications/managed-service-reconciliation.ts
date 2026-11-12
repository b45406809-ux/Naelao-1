import type { AgentsEnv } from "../index.js";

export interface ManagedServiceReconciliationAdapter {
  provider: string;
  serviceId: string;
  runDue(env: AgentsEnv, now: Date, limit: number): Promise<{ checked: number; reconciled: number; deferred: number; failed: number }>;
}

/** Provider-neutral scheduled dispatcher. Each adapter owns its provider-specific read-only recovery rules. */
export async function reconcileManagedServiceOperations(
  env: AgentsEnv,
  adapters: ManagedServiceReconciliationAdapter[],
  now = new Date(),
  totalLimit = 25,
) {
  if (!Number.isSafeInteger(totalLimit) || totalLimit < 1 || totalLimit > 100) throw new Error("managed_service_reconciliation_limit_invalid");
  const identities = new Set<string>();
  for (const adapter of adapters) {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(adapter.provider) || !/^[a-z][a-z0-9_.:-]{1,128}$/.test(adapter.serviceId)
      || identities.has(`${adapter.provider}:${adapter.serviceId}`)) throw new Error("managed_service_reconciliation_adapter_invalid");
    identities.add(`${adapter.provider}:${adapter.serviceId}`);
  }
  let remaining = totalLimit;
  const result = { adapters: adapters.length, checked: 0, reconciled: 0, deferred: 0, failed: 0 };
  for (const adapter of adapters) {
    if (!remaining) break;
    try {
      const outcome = await adapter.runDue(env, now, Math.min(remaining, 25));
      if ([outcome.checked, outcome.reconciled, outcome.deferred, outcome.failed].some(value => !Number.isSafeInteger(value) || value < 0)
        || outcome.reconciled + outcome.deferred + outcome.failed > outcome.checked || outcome.checked > remaining) {
        result.failed++;
        continue;
      }
      result.checked += outcome.checked;
      result.reconciled += outcome.reconciled;
      result.deferred += outcome.deferred;
      result.failed += outcome.failed;
      remaining -= outcome.checked;
    } catch {
      // A broken provider adapter must not prevent other due providers from reconciling.
      result.failed++;
    }
  }
  return result;
}
