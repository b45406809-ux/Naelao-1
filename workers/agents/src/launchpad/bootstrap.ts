/**
 * Template bootstrap execution — the shared "make the template actually configure the space"
 * step, callable from BOTH the provisioner (at creation time) and the agents worker's
 * POST /spaces/:spaceId/bootstrap/complete (the dashboard wizard's explicit finish call).
 *
 * WHY THIS EXISTS (a real, live-confirmed bug this module fixes):
 * The provisioner used to only RECORD the template's bootstrap into config_json.onboarding with
 * status "pending" — nothing executed it. The single caller that actually ran it was the BUILDER
 * dashboard's onboarding page. An end user creating a business through apps/shell (the Launchpad
 * end-user path — the main path) therefore got a space with agents installed but NO projects, NO
 * starter threads, and setup scripts that never ran; onboarding sat at "pending" forever.
 * Verified live against production before this module was written: a real whop-seller business
 * reached status 'active' with only the auto-provisioned "Wallet" project — none of the
 * template's own Members/Support/Content projects existed.
 *
 * Splitting the bootstrap into two phases is the point:
 *   STRUCTURAL (seedTemplateProjects) — projects + starter threads. Needs no credentials, so it
 *     always runs at provision time, for every creation path.
 *   SETUP (setup_scripts, credential prompts) — may genuinely need a connected account first
 *     (whop-seller's `mcp.list_tools` is meaningless before the Whop account is connected), so
 *     it stays gated behind the onboarding flow rather than firing against nothing.
 *
 * Project creation is naturally idempotent: SpaceDO has a UNIQUE INDEX on (space_id, name), so a
 * re-run (a queue retry, or the dashboard calling bootstrap/complete after the provisioner
 * already seeded) fails that one insert and is skipped rather than duplicating.
 */

/** A bootstrap project seed, normalized from spacetype.ts's `string | TemplateProjectSeed`. */
export interface NormalizedProjectSeed {
  name: string;
  default_agent_id?: string;
}

/** The two calls this module needs, supplied by the caller so it works from any worker (the
 *  provisioner and the agents worker bind SPACES_WORKER differently but both have one). */
export interface BootstrapDeps {
  /** POST a JSON body to a spaces-worker path, already carrying the caller's internal-token
   *  headers. Returns the Response so the caller's own auth/retry conventions stay theirs. */
  postToSpaces(path: string, body: unknown): Promise<Response>;
}

/** Normalize spacetype.ts's mixed `string | {name, default_agent_id?}` seed form to one shape. */
export function normalizeProjectSeeds(
  seeds: Array<string | { name: string; default_agent_id?: string }> | undefined
): NormalizedProjectSeed[] {
  return (seeds ?? []).map((p) => (typeof p === "string" ? { name: p } : p));
}

/**
 * Create a template's bootstrap projects, each pre-bound to its default agent, and seed a starter
 * thread in any project that HAS a default agent (an unbound reference project like "Products" or
 * "Members" gets no thread — nothing runs there automatically, so an empty thread would be noise).
 *
 * Best-effort per project, matching every other bootstrap/provisioning step in this codebase: one
 * project failing never aborts the rest, and never fails the caller's own operation. Returns the
 * names actually created so the caller can report/log real results rather than assumed ones.
 */
export async function seedTemplateProjects(
  deps: BootstrapDeps,
  spaceId: string,
  tenantId: string,
  seeds: NormalizedProjectSeed[]
): Promise<string[]> {
  const created: string[] = [];
  for (const seed of seeds) {
    try {
      const res = await deps.postToSpaces(`/spaces/${spaceId}/projects`, {
        name: seed.name,
        ...(seed.default_agent_id ? { default_agent_id: seed.default_agent_id } : {}),
      });
      // A non-ok here is usually the UNIQUE(space_id, name) constraint on a re-run — expected and
      // safe to skip, not an error worth failing the provision over.
      if (!res.ok) continue;
      created.push(seed.name);

      if (!seed.default_agent_id) continue;
      const project = (await res.json().catch(() => ({}))) as { id?: string };
      if (!project.id) continue;
      try {
        await deps.postToSpaces(`/spaces/${spaceId}/threads`, {
          space_id: spaceId,
          tenant_id: tenantId,
          project_id: project.id,
          title: seed.name,
        });
      } catch (err) {
        console.warn(`[bootstrap] starter thread failed (${seed.name}) for ${spaceId}:`, (err as Error).message);
      }
    } catch (err) {
      console.warn(`[bootstrap] project create failed (${seed.name}) for ${spaceId}:`, (err as Error).message);
    }
  }
  return created;
}
