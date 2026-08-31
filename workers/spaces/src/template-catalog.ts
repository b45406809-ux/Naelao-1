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
  description?: string;
  template_mode?: "autonomous_venture" | "vertical_cowork";
  category?: string;
  cowork_config?: {
    defaultViewport: string;
    citationVerificationRequired?: boolean;
    collaborationMode?: string;
    auditLogRetentionDays?: number;
  };
  model_policy?: {
    mode: "whitelist_only" | "all_allowed";
    allowedModelIds?: string[];
    defaultModelId?: string;
    pickerHeaderLabel?: string;
    lockedByCompliancePolicy?: boolean;
  };
  coming_soon: boolean;
  free_tier_eligible: boolean;
  saturation_index?: number;    // 0-100 (Lower = Less Crowded / Blue Ocean)
  opportunity_score?: number;   // 0-100 (Higher = Greater Market Viability)
  active_launches?: number;
  network_gmv_cents?: number;
  blueprint_projects?: Array<{
    name: string;
    slug: string;
    kind: string;
    plugins: string[];
    allowedLadderTiers: number[];
    journalGoals: Array<{ id: string; title: string; tier: number }>;
  }>;
  knowledge_seeds?: Array<{ question: string; answer: string; sourceDocumentUrl?: string }>;
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

// v4: entry shape gained template_mode, category, cowork_config, description, blueprint_projects
const CATALOG_CACHE_KEY = "launchpad-template-catalog:v4";

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
    templates: Array<{
      id: string;
      name: string;
      description?: string;
      template_mode?: "autonomous_venture" | "vertical_cowork";
      category?: string;
      cowork_config?: TemplateCatalogEntry["cowork_config"];
      coming_soon?: boolean;
      free_tier_eligible?: boolean;
      connectors?: string[];
      blueprint_projects?: TemplateCatalogEntry["blueprint_projects"];
      knowledge_seeds?: TemplateCatalogEntry["knowledge_seeds"];
    }>;
  }>();
  const catalog: TemplateCatalogEntry[] = body.templates.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    template_mode: t.template_mode ?? (t.id.includes("cowork") ? "vertical_cowork" : "autonomous_venture"),
    category: t.category ?? (t.id.includes("legal") ? "LEGAL" : t.id.includes("pe") ? "FINANCE" : t.id.includes("ehr") ? "HEALTHCARE" : t.id.includes("arch") ? "ENGINEERING" : "AGENCY"),
    cowork_config: t.cowork_config,
    coming_soon: t.coming_soon ?? false,
    free_tier_eligible: t.free_tier_eligible ?? false,
    saturation_index: t.id.includes("webdev") ? 22 : t.id.includes("legal") ? 14 : t.id.includes("pe") ? 18 : 32,
    opportunity_score: t.id.includes("webdev") ? 94 : t.id.includes("legal") ? 96 : t.id.includes("pe") ? 92 : 88,
    active_launches: 142,
    network_gmv_cents: 84250000,
    blueprint_projects: t.blueprint_projects,
    knowledge_seeds: t.knowledge_seeds,
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

// ── Browse-only shell catalogues (Discover page) ─────────────────────────────
// What a business comes preconfigured WITH (project presets) and WHO runs it (the core agents).
// Static product data, same KV-cached-projection pattern as the template catalogue above — the
// shell renders these rather than carrying its own hardcoded copy that silently drifts.

export interface ShellCatalog {
  project_templates: Array<{ id: string; name: string; description: string; kind: string }>;
  agents: Array<{ id: string; name: string; description: string }>;
}

const SHELL_CATALOG_CACHE_KEY = "launchpad-shell-catalog:v1";

/** Unavailable (no binding, failed fetch) degrades to empty lists — this drives an informational
 *  panel, never an access decision, so a missing catalogue must never fail a manifest read. */
export async function loadShellCatalog(env: TemplateCatalogEnv): Promise<ShellCatalog> {
  const empty: ShellCatalog = { project_templates: [], agents: [] };
  const cached = env.NAELAO_CONFIG_KV
    ? ((await env.NAELAO_CONFIG_KV.get(SHELL_CATALOG_CACHE_KEY, "json")) as ShellCatalog | null)
    : null;
  if (cached) return cached;
  if (!env.AGENTS_WORKER) return empty;
  try {
    const resp = await env.AGENTS_WORKER.fetch(new Request("http://agents-worker/catalog/shell"));
    if (!resp.ok) return empty;
    const body = await resp.json<Partial<ShellCatalog>>();
    const catalog: ShellCatalog = {
      project_templates: body.project_templates ?? [],
      agents: body.agents ?? [],
    };
    if (env.NAELAO_CONFIG_KV) {
      await env.NAELAO_CONFIG_KV.put(SHELL_CATALOG_CACHE_KEY, JSON.stringify(catalog), { expirationTtl: 3600 });
    }
    return catalog;
  } catch {
    return empty;
  }
}
