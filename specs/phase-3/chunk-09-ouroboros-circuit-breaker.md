
```markdown
---
chunk_id: "phase-3-chunk-09"
phase: 3
include_files:
  - workers/agents/src/script-engine/prebuilt/agent-coordination.ts
  - workers/router/src/index.ts
repomix_include:
  - "workers/agents/src/script-engine/prebuilt/agent-coordination.ts"
  - "workers/router/src/index.ts"
expected_outputs:
  - workers/agents/src/script-engine/prebuilt/agent-coordination.ts
  - workers/router/src/index.ts
---

# Phase 3 — Chunk 09: Ouroboros Circuit Breaker & Hop Counting

## 1. Executive Summary & Architectural Vision

In a multi-agent, event-driven operating system, the most dangerous vulnerability is the **Ouroboros Loop (Infinite Recursion)**. 

If `@ArchitectBot` delegates a task to `@DevBot`, and `@DevBot` encounters a persistent error (e.g., an unresolvable compiler error), a poorly constrained `@DevBot` might attempt to delegate the problem *back* to `@ArchitectBot`. Without structural limits, the two agents will ping-pong indefinitely, burning hundreds of dollars in LLM tokens in a matter of minutes.

The same danger applies to webhooks: an automation that posts to a Slack channel might trigger a Slack webhook that re-triggers the automation.

**The Solution: The "Hop Count" Capability Header.**
Inspired by IP packet "Time to Live" (TTL) architecture, every execution payload and internal HTTP request passing through AVOS carries an immutable `x-avos-hop-count` header. 
* A user's original request starts at `Hop 0`.
* A delegation from `@Architect` to `@Dev` is `Hop 1`.
* If a task attempts to exceed a hardcoded horizon (e.g., `Hop 2`), the **Edge Router** and **Agent Coordination Tool** physically short-circuit the execution. The model is forced to yield to a human.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       THE HOP-COUNT CIRCUIT BREAKER                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ [ Hop 0 ] Human: "@ArchitectBot, please scaffold a new billing module."     │
│             │                                                               │
│             ▼ (ctx.agent.delegate)                                          │
│ [ Hop 1 ] @ArchitectBot ──► delegates to ──► @DevBot                        │
│             │                                                               │
│             ▼ (ctx.agent.delegate - Error Recovery Attempt)                 │
│ [ Hop 2 ] @DevBot ──► delegates to ──► @ReviewBot                           │
│             │                                                               │
│             ▼ (ctx.agent.delegate - Fails!)                                 │
│ [ 🛑 BLOCK ] @ReviewBot attempts to delegate back to @ArchitectBot.         │
│              Circuit Breaker intercepts: "Max delegation depth reached."    │
│              Forced Transition ──► `BLOCKED_AWAITING_HUMAN`                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Implementation Requirements

### A. Update `workers/router/src/index.ts` (The Perimeter Middleware)

The primary edge router must intercept all incoming requests (both from external webhooks and internal service-to-service calls) and validate the hop count.

1. **Add the Hop Count Middleware:**
   Implement a middleware that runs early in the Hono application stack to inspect `x-avos-hop-count`.

2. **Validation Rules:**
   * If the header is missing, initialize it to `0`.
   * If the header is present, parse it as an integer. Reject `NaN` or negative values with `400 Bad Request`.
   * If `hopCount > 2`, immediately abort the request with `429 Too Many Requests` (or a custom `400` payload) stating the circuit breaker tripped.
   * Attach the `hopCount` to the Hono context (`c.set('hopCount', hopCount)`) so downstream route handlers can attach the *incremented* value to any outbound requests they make.

**Code Requirements for `workers/router/src/index.ts`:**
```typescript
import { Context, Next } from "hono";

// Middleware to prevent infinite agent/automation loops
export async function ouroborosCircuitBreaker(c: Context, next: Next) {
  const hopHeader = c.req.header("x-avos-hop-count");
  let hopCount = 0;

  if (hopHeader) {
    hopCount = parseInt(hopHeader, 10);
    if (isNaN(hopCount) || hopCount < 0) {
      return c.json({ error: "Invalid x-avos-hop-count header" }, 400);
    }
  }

  // Hard limit: No task can be delegated or re-triggered more than 2 times.
  const MAX_HOPS = 2;
  if (hopCount > MAX_HOPS) {
    console.warn(`[CIRCUIT BREAKER] Request blocked. Hop count ${hopCount} exceeds limit of ${MAX_HOPS}. Path: ${c.req.path}`);
    return c.json({ 
      error: "circuit_breaker_tripped",
      message: `Maximum automated hop depth of ${MAX_HOPS} reached. To prevent infinite loops, this action has been halted.` 
    }, 429);
  }

  // Store the current hop count in context for downstream services
  c.set("hopCount", hopCount);
  
  await next();
}

// Ensure this is registered in the Hono app before routes are processed:
// app.use("*", ouroborosCircuitBreaker);
```

---

### B. Update `workers/agents/src/script-engine/prebuilt/agent-coordination.ts` (Agent Tool)

When an agent explicitly uses the `Delegate` (or `agent.consult` / `thread.send_message`) tool to pass work to another agent, the tool itself must enforce the hop count and inform the LLM *why* it cannot delegate further. 

If we only block it at the router, the LLM will see a "429 Error" and might burn its retry budget trying again. By catching it in the tool execution layer, we return a semantic error telling the AI to stop trying.

1. **Extract Current Hop from Context:**
   The `ctx.env` or `ctx` must pass down the `hopCount` derived from the initial request.
2. **Pre-flight Enforcement:**
   Before minting the delegation token or making the DO-to-DO dispatch, check `hopCount >= 2`.
3. **Semantic Refusal:**
   If the limit is reached, return a cleanly formatted object to the LLM indicating it MUST resolve the issue itself or ask the human.
4. **Header Injection:**
   If permitted, ensure the downstream dispatch (via HTTP or DO binding) includes `"x-avos-hop-count": String(currentHop + 1)`.

**Code Requirements for `workers/agents/src/script-engine/prebuilt/agent-coordination.ts`:**
```typescript
/**
 * Delegate a task to another agent.
 */
export async function delegateTask(
  targetRole: string, 
  taskDescription: string, 
  contextFiles: string[], 
  ctx: any // Assuming PrebuiltOpContext
) {
  // 1. Extract current hop count (default to 0 if originating directly from user)
  const currentHop = ctx.env.hopCount || 0;
  const MAX_HOPS = 2;

  // 2. Pre-flight Circuit Breaker
  if (currentHop >= MAX_HOPS) {
    return {
      success: false,
      error_code: "MAX_DELEGATION_DEPTH_REACHED",
      message: `Circuit Breaker activated: You are at delegation depth ${currentHop}. You cannot delegate this task any further. You MUST either complete the task yourself using available tools, or use 'give_up' / 'answer' to explicitly request human intervention.`
    };
  }

  // 3. Prepare Downstream Request Headers
  const nextHopCount = currentHop + 1;
  const outboundHeaders = {
    ...ctx.env.internalHeaders(), // Includes the HMAC tokens
    "x-avos-hop-count": String(nextHopCount),
    "x-naelao-user-id": ctx.env.userId, // Cryptographic delegation chaining
  };

  try {
    // 4. Dispatch the sub-agent task (Implementation depends on your DO/HTTP dispatch pattern)
    // Example:
    // const response = await fetch(`http://internal/spaces/${ctx.env.spaceId}/agent/mention-run`, {
    //   method: "POST",
    //   headers: outboundHeaders,
    //   body: JSON.stringify({ target: targetRole, task: taskDescription, context: contextFiles })
    // });
    
    // return await response.json();

    return {
      success: true,
      hop_level: nextHopCount,
      message: `Successfully delegated to ${targetRole}.`
    };

  } catch (err: any) {
    return {
      success: false,
      error: `Failed to delegate: ${err.message}`
    };
  }
}
```

---

## 3. Strict Guidelines for the AI Implementer

1. **Exact Patching:** You are updating critical security and routing infrastructure. Do not delete or overwrite the existing JWT/HMAC authorization logic in `workers/router/src/index.ts`. Add the `ouroborosCircuitBreaker` alongside them.
2. **Context Passing:** Ensure that when the router proxies to the agent Worker (`AGENTS_WORKER.fetch`), the `x-avos-hop-count` header is explicitly forwarded if it exists on the incoming request, or injected if computed by the middleware.
3. **No Truncation:** Provide the full updated files using the `apply_chunk_code` tool. Do not use `// ... existing code ...`.
```
