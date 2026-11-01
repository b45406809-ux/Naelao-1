/** Preflight the complete model input. A char-based estimate is deliberately conservative and
 * is only a guardrail; provider usage and overflow responses remain authoritative. */
const OPTIONAL_FIELDS = ["memory_context", "conversation", "observation", "candidate_scripts", "available_operations", "steps_so_far", "earlier_steps", "repair_target", "plan"] as const;

export interface BoundedRequestContext {
  system: string;
  user: string;
  inputChars: number;
  trimmedFields: string[];
}

export function boundReasonerRequestContext(system: string, user: string, toolSchema: unknown, windowTokens: number, outputTokens = 1500): BoundedRequestContext {
  const limitChars = Math.max(1024, Math.floor(Math.max(2048, windowTokens - outputTokens - 1000) * 3.2));
  const payload = JSON.parse(user) as Record<string, unknown>;
  const trimmedFields: string[] = [];
  const size = () => system.length + JSON.stringify(payload).length + JSON.stringify(toolSchema).length;

  // Preserve the goal, identity, and system protocol. Trim optional/context-heavy fields in
  // descending safety order, retaining valid JSON and a useful prefix for each field.
  for (const key of OPTIONAL_FIELDS) {
    if (size() <= limitChars) break;
    const value = payload[key];
    if (value === undefined) continue;
    const excess = size() - limitChars;
    if (typeof value === "string") {
      payload[key] = value.slice(0, Math.max(0, value.length - excess - 64)) + " [context trimmed]";
    } else if (Array.isArray(value)) {
      let next = value;
      while (size() > limitChars && next.length) {
        // `slice(-0)` is `slice(0)`, so the previous halving loop stopped making
        // progress at a one-item remainder (commonly reached from a two-group
        // operations catalog). A long Project Bot prompt could then spin the DO
        // indefinitely before making any provider request. Explicitly drop the
        // final item when halving reaches zero.
        const retained = Math.floor(next.length / 2);
        next = retained === 0 ? [] : next.slice(-retained);
        payload[key] = next;
      }
    } else if (value && typeof value === "object") {
      delete payload[key];
    } else {
      delete payload[key];
    }
    trimmedFields.push(key);
    // Repeatedly reduce the same large field if the first cut was not enough.
    if (size() > limitChars && typeof payload[key] === "string") {
      payload[key] = (payload[key] as string).slice(0, Math.max(0, (payload[key] as string).length - (size() - limitChars) - 64)) + " [context trimmed]";
    }
  }

  const boundedUser = JSON.stringify(payload);
  const inputChars = system.length + boundedUser.length + JSON.stringify(toolSchema).length;
  if (inputChars > limitChars) {
    throw new Error(
      `reasoner_fixed_prompt_exceeds_context_budget:input_chars=${inputChars}:limit_chars=${limitChars}:system_chars=${system.length}:user_chars=${boundedUser.length}:schema_chars=${JSON.stringify(toolSchema).length}`
    );
  }
  return { system, user: boundedUser, inputChars, trimmedFields };
}
