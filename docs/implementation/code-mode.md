# CLI Composition and Code Mode

Naelao remains CLI-first. The agent's main interaction is Bash against the virtual CLI, and reusable commands execute through Naelao's existing six-tier ladder. Code Mode names a useful pattern inside that architecture: write a small program that runs several permitted commands, filters intermediate output, and returns a bounded result. It is not a second agent tool surface or execution owner.

## Compose commands

JavaScript/TypeScript command modules receive a host-injected `ctx.cli` facade. Discover commands with `ctx.cli.search` and `ctx.cli.help`; invoke one registered command as argv with `ctx.cli.run`. The adapter accepts a single command and `--params <JSON>`; shell parsing, pipelines, and redirects remain in the virtual CLI. For example:

```ts
export async function run(args, ctx) {
  const commands = await ctx.cli.search("conversation");
  const help = await ctx.cli.help("conversation.search");
  const page = await ctx.cli.run(["conversation.search", "--params", JSON.stringify({
    query: args.query,
    session_id: args.session_id,
    limit: 5,
    scan_limit: 500,
  })]);
  return {
    results: page.results,
    complete: page.complete,
    next_cursor: page.next_cursor,
  };
}
```

`ctx` is injected by the host; runtime imports and ambient network access remain forbidden. Search results and descriptions are limited to the intersection of explicit invocation capabilities, enabled worker tools, live host grants, role/workspace constraints, and the execution ceiling. Discovery does not grant a method. Revocation is checked again for each tool call and before delivering its result. Discovery shares the 64-call and bounded-payload RPC limits.

`ctx.cli.help` returns command usage text. Internal host schemas may help validate a command, but they are not presented as model-native tools or injected into guest code. Naelao's existing host validation remains authoritative.

MCP remains an authenticated connector protocol behind its registered Naelao CLI commands. The command invokes the account-scoped MCP hub and Vault; connector credentials never enter generated code.

## Intermediate results and safety

Host command calls from code preserve ordinary mutation guards, approvals, tier limits, usage accounting and execution records. Intermediate JSON is delivered to code before model-output offloading and is constrained by the RPC byte limit (64 KiB by default). An oversized intermediate value fails explicitly; use source pagination or bounded queries. Only the final composition result is delivered through the model-output path. Trusted command implementations may have their own documented pagination or truncation.

Consequential calls must run sequentially with stable action/idempotency identifiers. An uncertain effect requires reconciliation. A fresh Tier 2 execution does not provide durable replay. Long waits, schedules, and resumable sequences use Naelao's existing dynamic workflows with stable step keys and host approvals; do not restart the composition to bypass a pending approval. Compensation is explicit and specific to the provider operation.

## Reusable commands

After verification, author a scoped script/skill with `code_capabilities`, or a validated virtual CLI module with one capability header:

```ts
// @naelao-capabilities: ["tool:conversation.search"]
export async function run(args, ctx) {
  return ctx.cli.run(["conversation.search", "--params", JSON.stringify({
    query: args.argv[0], session_id: args.argv[1], limit: 5,
  })]);
}
```

Virtual CLI modules live in the existing scoped machine-state `bin/` namespace, exposed as `/.avos/bin`. Their catalogue and execution now use the same prefix. Each load validates the source and capability declaration; each invocation reauthorizes the requested capabilities. Runtime receipts identify the compiled source digest. Saving code never preserves the creator's former authority. There is no automatic promotion of failed, paused, or uncertain executions into trusted skills.

## Verification

Tests exercise the real worker catalogue and guest facade, selected-capability filtering, revocation, bounded discovery, MCP intermediate-result delivery, explicit invocation capabilities, reusable command declarations, and command execution. Live Cloudflare deployment and external connector acceptance require configured bindings and are separate from these local checks.
