export const OUROBOROS_MAX_HOPS = 2;

export interface CircuitBreakerEvent {
  type: "ouroboros_loop_detected";
  causalChain: string;
  hopCount: number;
  occurredAt: string;
}
export interface CircuitBreakerEnv {
  OUROBOROS_CIRCUITS?: KVNamespace;
  logCircuitBreakerTrip?(event: CircuitBreakerEvent): void | Promise<void>;
}

/** Stops recursive automations and remembers the causal chain for one hour at the edge. */
export async function inspectAutomationCircuit(
  request: Request,
  env: CircuitBreakerEnv
): Promise<
  { allowed: true; headers: Headers } | { allowed: false; response: Response }
> {
  const raw = request.headers.get("x-avos-hop-count") ?? "0";
  if (!/^(?:0|[1-9]\d{0,9})$/.test(raw))
    return {
      allowed: false,
      response: Response.json(
        { error_code: "invalid_hop_count" },
        { status: 400 }
      ),
    };
  const hopCount = Number(raw);
  const causalChain =
    request.headers.get("x-avos-causal-chain") ??
    request.headers.get("x-avos-event-id") ??
    "unknown";
  if (
    !Number.isSafeInteger(hopCount) ||
    hopCount < 0 ||
    causalChain.length > 256
  )
    return {
      allowed: false,
      response: Response.json(
        { error_code: "invalid_hop_count" },
        { status: 400 }
      ),
    };
  if (hopCount > OUROBOROS_MAX_HOPS) {
    const event: CircuitBreakerEvent = {
      type: "ouroboros_loop_detected",
      causalChain,
      hopCount,
      occurredAt: new Date().toISOString(),
    };
    await Promise.allSettled([
      env.OUROBOROS_CIRCUITS?.put(
        `ouroboros:${causalChain}`,
        JSON.stringify(event),
        { expirationTtl: 3600 }
      ),
      env.logCircuitBreakerTrip?.(event),
    ]);
    return {
      allowed: false,
      response: Response.json(
        { error_code: event.type, causal_chain: causalChain },
        { status: 409 }
      ),
    };
  }
  const headers = new Headers(request.headers);
  headers.set("x-avos-hop-count", String(hopCount + 1));
  headers.set("x-avos-causal-chain", causalChain);
  return { allowed: true, headers };
}
