// Launchpad template catalogue + the free-tier eligibility gate (spec G-BF08, Appendix BF).
//
// loadTemplateCatalog was Phase F's single source of truth for template data in this worker
// (a KV-cached call to the agents worker's real GET /templates — never a hand-maintained copy).
// Extracted from index.ts so business-create.ts / create-space.ts can reuse it without importing
// index.ts (both files keep their one-way import rule), and extended with `free_tier_eligible`
// so the flag — which existed on LaunchpadTemplate and in the dashboard projection since Phase F
// but was NEVER enforced anywhere — finally gets teeth at creation time.

export interface TemplateCatalogEntry {
  id: string;
  name: string;
  coming_soon: boolean;
  free_tier_eligible: boolean;
  /** Connector catalogue ids (catalogue.ts) this template's onboarding recommends connecting —
   *  e.g. creator-store recommends higgsfield + social platforms for marketing. Empty means "no
   *  specific recommendation," not "connect nothing" — the shell still shows the full catalogue
   *  elsewhere; this only drives the onboarding "Recommended apps" panel. */
  connectors: string[];
}

export interface TemplateCatalogEnv {
  NAELAO_CONFIG_KV?: KVNamespace;
  AGENTS_WORKER?: Fetcher;
}

// v3: entry shape gained connectors (v2 gained free_tier_eligible) — a stale cache entry from an
// older shape would make the onboarding "Recommended apps" panel silently show nothing for up to
// an hour after deploy, so the key is bumped again rather than reusing v2.
const CATALOG_CACHE_KEY = "launchpad-template-catalog:v3";

/**
 * Load the catalogue, or null when it is genuinely UNAVAILABLE (no AGENTS_WORKER binding, or
 * the fetch failed). Callers that gate on eligibility need the distinction: an unavailable
 * catalogue must not be confused with "this template doesn't exist."
 */
export async function loadTemplateCatalogOrNull(env: TemplateCatalogEnv): Promise<TemplateCatalogEntry[] | null> {
  const cached = env.NAELAO_CONFIG_KV
    ? (await env.NAELAO_CONFIG_KV.get(CATALOG_CACHE_KEY, "json")) as TemplateCatalogEntry[] | null
    : null;
  if (cached) return cached;
  if (!env.AGENTS_WORKER) return null;
  let resp: Response;
  try {
    resp = await env.AGENTS_WORKER.fetch(new Request("http://agents-worker/templates"));
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const body = await resp.json<{
    templates: Array<{ id: string; name: string; coming_soon?: boolean; free_tier_eligible?: boolean; connectors?: string[] }>;
  }>();
  const catalog: TemplateCatalogEntry[] = body.templates.map((t) => ({
    id: t.id,
    name: t.name,
    coming_soon: t.coming_soon ?? false,
    free_tier_eligible: t.free_tier_eligible ?? false,
    connectors: t.connectors ?? [],
  }));
  if (env.NAELAO_CONFIG_KV) {
    await env.NAELAO_CONFIG_KV.put(CATALOG_CACHE_KEY, JSON.stringify(catalog), { expirationTtl: 3600 });
  }
  return catalog;
}

/** Shape-compatible wrapper for callers that render the catalogue (shell/manifest): unavailable
 *  degrades to an empty list, exactly as the pre-extraction loadTemplateCatalog behaved. */
export async function loadTemplateCatalog(env: TemplateCatalogEnv): Promise<TemplateCatalogEntry[]> {
  return (await loadTemplateCatalogOrNull(env)) ?? [];
}

/** The org's plan tier (orgs.id == tenantId, per the Phase 4 enforceSpaceQuota fix). Unknown
 *  org or a lookup error resolves to "free" — the most restrictive tier (fail closed). */
export async function resolveOrgPlanTier(db: D1Database, tenantId: string): Promise<string> {
  try {
    const org = await db.prepare("SELECT plan_tier FROM orgs WHERE id = ?").bind(tenantId).first<{ plan_tier: string }>();
    return org?.plan_tier ?? "free";
  } catch {
    return "free";
  }
}

export type FreeTierGateResult =
  | { ok: true }
  | { ok: false; error_code: "plan_upgrade_required"; message: string; status: 403 };

/**
 * G-BF08: on the free tier, every requested template must be free_tier_eligible. Semantics:
 * - Empty template list ("Custom — build with the assistant") always passes; usage caps bound it.
 * - Non-free tiers pass without loading the catalogue at all (no added latency/dependency).
 * - Catalogue UNAVAILABLE (null) passes: this is a monetization gate, not a security boundary,
 *   and failing closed here would 403 every free-plan creation during an agents-worker outage
 *   (and break every dev/test environment without the binding). The tier lookup itself still
 *   fails CLOSED (unknown org → free).
 * - Catalogue loaded: a template that is absent from it or not flagged eligible is rejected,
 *   naming the offending template ids.
 */
export async function checkFreeTierTemplateEligibility(
  db: D1Database,
  env: TemplateCatalogEnv,
  tenantId: string,
  templateIds: string[]
): Promise<FreeTierGateResult> {
  if (templateIds.length === 0) return { ok: true };
  const tier = await resolveOrgPlanTier(db, tenantId);
  if (tier !== "free") return { ok: true };
  const catalog = await loadTemplateCatalogOrNull(env);
  if (catalog === null) return { ok: true };
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const blocked = templateIds.filter((id) => byId.get(id)?.free_tier_eligible !== true);
  if (blocked.length === 0) return { ok: true };
  return {
    ok: false,
    error_code: "plan_upgrade_required",
    status: 403,
    message: `Not available on the free plan: ${blocked.join(", ")}. Upgrade your plan or choose a free-eligible template.`,
  };
}
