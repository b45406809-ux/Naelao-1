/** Node unit-test shim for Cloudflare's Agents SDK. Cloudflare runtime integration is verified by
 * Wrangler's dry-run build; route tests only need the Worker to load without the `cloudflare:` ESM
 * module specifier used internally by the SDK. */
export class Agent<Env = unknown> {
  protected env!: Env;
  protected ctx = { id: { name: "test-agent" } };
}

export async function routeAgentRequest(): Promise<Response | null> {
  return null;
}
