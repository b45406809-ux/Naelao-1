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
  /** GET a spaces-worker path with the same auth as postToSpaces — only seedGeneralProject uses
   *  this, to look up an already-existing General project by name after a UNIQUE-constraint
   *  create failure, without inventing a new backend route just for that lookup. Optional so
   *  every existing BootstrapDeps caller (which only ever POSTs) doesn't need updating for a
   *  capability it never uses. */
  getFromSpaces?(path: string): Promise<Response>;
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
/** A project this seeder created. The id is present whenever the create response carried one —
 *  a caller that needs to reference the project later (an event rule naming a handoff target)
 *  has no other way to learn it. */
export interface SeededProject {
  name: string;
  id?: string;
}

/** The name every business's default project gets — see seedGeneralProject's own header for why
 *  this needs to be a shared constant rather than a string repeated at each call site. */
export const GENERAL_PROJECT_NAME = "General";

/**
 * Every business gets one ordinary, always-there project to land in — the thing `/projects`
 * (bare, no id) now redirects straight into instead of showing a picker first. Bound to the
 * Space Assistant like any other default-agent project, so a fresh business is immediately
 * chattable inside a real project rather than only at the product root.
 *
 * Idempotent by construction (SpaceDO's UNIQUE(space_id, name), same as seedTemplateProjects) —
 * safe to call unconditionally at provision time regardless of whether the business also seeds
 * template-specific projects, and safe to call again from bootstrap/complete without duplicating.
 * Returns the project id when one now exists (created just now, or already did), or undefined on
 * a genuine failure — best-effort by design, matching every other provisioning-time seed in this
 * codebase: a business must never fail to activate because this one convenience project didn't
 * get created.
 */
export async function seedGeneralProject(deps: BootstrapDeps, spaceId: string): Promise<string | undefined> {
  try {
    const res = await deps.postToSpaces(`/spaces/${spaceId}/projects`, {
      name: GENERAL_PROJECT_NAME,
      description: "Your default workspace — chat and files land here unless you create another project.",
      default_agent_id: "naelao-agent",
      // Explicit, not left to default: this is the business-wide landing project every member
      // should land in, not a private project scoped to whichever caller happens to trigger the
      // seed (a system caller with no created_by would otherwise create a project only the
      // space's own owner/admin could see — see Phase T1's private-by-default rule).
      visibility: "public",
    });
    if (res.ok) {
      const project = (await res.json().catch(() => ({}))) as { id?: string };
      return project.id;
    }
    // Not ok almost always means the UNIQUE(space_id, name) constraint fired because one already
    // exists (a re-run, or bootstrap/complete running after the provisioner already seeded one) —
    // look it up rather than treating that as a failure.
    if (!deps.getFromSpaces) return undefined;
    const listRes = await deps.getFromSpaces(`/spaces/${spaceId}/projects`);
    if (!listRes.ok) return undefined;
    const body = (await listRes.json().catch(() => ({}))) as { data?: Array<{ id: string; name: string }> };
    return body.data?.find((p) => p.name === GENERAL_PROJECT_NAME)?.id;
  } catch (err) {
    console.warn(`[bootstrap] General project seed failed for ${spaceId}:`, (err as Error).message);
    return undefined;
  }
}

export async function seedTemplateProjects(
  deps: BootstrapDeps,
  spaceId: string,
  tenantId: string,
  seeds: NormalizedProjectSeed[]
): Promise<SeededProject[]> {
  const created: SeededProject[] = [];
  for (const seed of seeds) {
    try {
      const res = await deps.postToSpaces(`/spaces/${spaceId}/projects`, {
        name: seed.name,
        ...(seed.default_agent_id ? { default_agent_id: seed.default_agent_id } : {}),
      });
      // A non-ok here is usually the UNIQUE(space_id, name) constraint on a re-run — expected and
      // safe to skip, not an error worth failing the provision over.
      if (!res.ok) continue;
      // The id is read for every project, not only bound ones: a caller wiring the pipeline
      // between projects (event rules naming a target) needs the id of the reference shelves too,
      // and it was already in this response — just discarded.
      const project = (await res.json().catch(() => ({}))) as { id?: string; created?: boolean };
      created.push({ name: seed.name, ...(project.id ? { id: project.id } : {}) });

      // Live-reported bug: this endpoint ALWAYS returns 201/ok even when `ON CONFLICT(space_id,
      // name) DO NOTHING` silently no-op'd on a name that already existed — this function's OWN
      // re-run (the provisioner seeds structurally at creation time, then bootstrap/complete seeds
      // the SAME templates again once an end user finishes the onboarding wizard) was therefore
      // never actually skipped by the `!res.ok` check above, and a starter thread got created a
      // second time for every already-existing project. `created` (added specifically to close
      // this) is what makes the skip real: no starter thread for a project that already existed.
      if (!seed.default_agent_id || !project.id || project.created === false) continue;
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
