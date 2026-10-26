# Scoped Code Mode

Naelao composes tools through the existing Tier 2 Worker isolate, RPC broker, planner/worker boundaries, and host tool surface. This implements the Code Mode pattern without depending on the experimental Cloudflare Code Mode package or introducing a second approval/runtime owner.

## Execute a composition

Discover operation names using the existing CLI `tools.search` and `tools.describe`, then invoke `code.run_js` with `code`, `args`, and an explicit top-level `capabilities` array. CLI invocation uses `code.run_js --params <JSON>`. For example, select `tool:conversation.search` and run:

```ts
export async function run(args, ctx) {
  const methods = await ctx.tools.search("conversation");
  const contract = await ctx.tools.describe("conversation.search");
  const page = await ctx.tools.call("conversation.search", {
    query: args.query,
    session_id: args.session_id,
    limit: 5,
    scan_limit: 500,
  });
  return {
    results: page.results,
    complete: page.complete,
    next_cursor: page.next_cursor,
  };
}
```

`ctx` is injected by the host; runtime imports and ambient network access remain forbidden. Search results and descriptions are limited to the intersection of explicit invocation capabilities, enabled worker tools, live host grants, role/workspace constraints, and the execution ceiling. Discovery does not grant a method. Revocation is checked again for each tool call and before delivering its result. Discovery shares the 64-call and bounded-payload RPC limits.

Host-owned JSON schemas produce TypeScript call signatures. `PrebuiltScript.inputSchemas` is optional; methods without a structured schema explicitly return a generic input signature plus the existing parameter hint. Result types remain `unknown`. Schema descriptions do not replace operation validation.

MCP uses canonical `mcp.list_tools` and `mcp.call` methods, retaining the existing bare-name aliases for compatibility. Calling `mcp.list_tools` obtains the upstream connector's actual method schemas. `mcp.call` invokes the selected method through the existing account-scoped MCP hub and Vault. Connector credentials never enter generated code.

## Intermediate results and safety

Host tool calls from code preserve ordinary mutation guards, approvals, tier limits, usage accounting and execution records. Intermediate JSON is delivered to code before model-output offloading and is constrained by the RPC byte limit (64 KiB by default). An oversized intermediate value fails explicitly; use source pagination or bounded queries. Only the final composition result is delivered through the model-output path. Trusted tool implementations may have their own documented pagination or truncation.

Consequential calls must run sequentially with stable action/idempotency identifiers. An uncertain effect requires reconciliation. A fresh Tier 2 execution does not provide durable replay. Long waits, schedules, and resumable sequences use Naelao's existing dynamic workflows with stable step keys and host approvals; do not restart the composition to bypass a pending approval. Compensation is explicit and specific to the provider operation.

## Reusable commands

After verification, author a scoped script/skill with `code_capabilities`, or a validated virtual CLI module with one capability header:

```ts
// @naelao-capabilities: ["tool:conversation.search"]
export async function run(args, ctx) {
  return ctx.tools.call("conversation.search", {
    query: args.argv[0], session_id: args.argv[1], limit: 5,
  });
}
```

Virtual CLI modules live in the existing scoped machine-state `bin/` namespace, exposed as `/.avos/bin`. Their catalogue and execution now use the same prefix. Each load validates the source and capability declaration; each invocation reauthorizes the requested capabilities. Runtime receipts identify the compiled source digest. Saving code never preserves the creator's former authority. There is no automatic promotion of failed, paused, or uncertain executions into trusted skills.

## Verification

Tests exercise the real worker catalogue and guest facade, selected-capability filtering, revocation, bounded discovery, MCP intermediate-result delivery, explicit invocation capabilities, reusable command declarations, and command execution. Live Cloudflare deployment and external connector acceptance require configured bindings and are separate from these local checks.
