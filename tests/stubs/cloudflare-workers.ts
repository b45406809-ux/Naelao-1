// Test stub for the `cloudflare:workers` runtime module so worker code (which
// extends DurableObject / WorkflowEntrypoint) can be imported in a plain Node/
// vitest environment. Only import-time class shapes are needed — DO instances
// are never constructed in these tests; routes are driven via app.fetch + mock env.

export class DurableObject {
  protected ctx: unknown;
  protected env: unknown;
  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkflowEntrypoint {
  protected ctx: unknown;
  protected env: unknown;
  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

// Types are erased at runtime; runtime placeholders keep named imports resolvable.
export const WorkflowStep = {} as unknown;
export const WorkflowEvent = {} as unknown;
