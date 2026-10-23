// Launchpad template catalogue + the free-tier eligibility gate (spec G-BF08, Appendix BF).
//
// loadTemplateCatalog was Phase F's single source of truth for template data in this worker
// (a KV-cached call to the agents worker's real GET /templates — never a hand-maintained copy).
// Extracted from index.ts so business-create.ts / create-space.ts can reuse it without importing
// index.ts (both files keep their one-way import rule), and extended with `free_tier_eligible`
// so the flag — which existed on LaunchpadTemplate and in the dashboard projection since Phase F
// but was NEVER enforced anywhere — finally gets teeth at creation time.

import { readBoundedResponseJson } from "@naelao/http";

export interface TemplateCatalogEntry {
  id: string;
  name: string;
  description: string;
  template_mode: "ave" | "cowork";
  vertical: string;
  wallet_mode: "business_wallet" | "company_budget";
  coming_soon: boolean;
  free_tier_eligible: boolean;
  presentation_profile?: "guided" | "balanced" | "advanced";
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

// v5: the catalogue's new verticals are free-tier eligible in local/initial rollout (v4 gained
// operating-model metadata, v3 gained connectors, v2 gained free_tier_eligible) — a stale cache entry from an
// older shape would make the onboarding "Recommended apps" panel silently show nothing for up to
// an hour after deploy, so the key is bumped again rather than reusing v2.
const CATALOG_CACHE_KEY = "launchpad-template-catalog:v5";
const CATALOG_REQUEST_TIMEOUT_MS = 5_000;
const CATALOG_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

function normalizeTemplateCatalog(value: unknown): TemplateCatalogEntry[] | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as { templates?: unknown }).templates)) return null;
  const templates = (value as { templates: unknown[] }).templates;
  if (templates.length > 500) return null;
  const result: TemplateCatalogEntry[] = [];
  for (const raw of templates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(t.id) ||
        typeof t.name !== "string" || !t.name.trim() || t.name.length > 160) return null;
    const connectors = Array.isArray(t.connectors) && t.connectors.length <= 50 &&
      t.connectors.every((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
      ? t.connectors as string[] : [];
    result.push({
      id: t.id,
      name: t.name.slice(0, 160),
      description: typeof t.description === "string" ? t.description.slice(0, 2000) : "Preconfigured workspace, agents and setup.",
      template_mode: t.template_mode === "cowork" ? "cowork" : "ave",
      vertical: typeof t.vertical === "string" ? t.vertical.slice(0, 120) : "Digital business",
      wallet_mode: t.wallet_mode === "company_budget" ? "company_budget" : "business_wallet",
      coming_soon: t.coming_soon === true,
      free_tier_eligible: t.free_tier_eligible === true,
      presentation_profile: t.presentation_profile === "advanced" || t.presentation_profile === "balanced" ? t.presentation_profile : "guided",
      connectors,
    });
  }
  return result;
}

/**
 * Load the catalogue, or null when it is genuinely UNAVAILABLE (no AGENTS_WORKER binding, or
 * the fetch failed). Callers that gate on eligibility need the distinction: an unavailable
 * catalogue must not be confused with "this template doesn't exist."
 */
export async function loadTemplateCatalogOrNull(env: TemplateCatalogEnv): Promise<TemplateCatalogEntry[] | null> {
  if (env.NAELAO_CONFIG_KV) {
    try {
      const cached = normalizeTemplateCatalog(await env.NAELAO_CONFIG_KV.get(CATALOG_CACHE_KEY, "json"));
      if (cached) return cached;
    } catch { /* a corrupt/unavailable cache is a cache miss */ }
  }
  if (!env.AGENTS_WORKER) return null;
  let resp: Response;
  try {
    resp = await env.AGENTS_WORKER.fetch(new Request("http://agents-worker/templates", { signal: AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS) }));
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  let catalog: TemplateCatalogEntry[] | null;
  try {
    catalog = normalizeTemplateCatalog(await readBoundedResponseJson<unknown>(resp, CATALOG_RESPONSE_MAX_BYTES));
  } catch { return null; }
  if (!catalog) return null;
  if (env.NAELAO_CONFIG_KV) {
    try { await env.NAELAO_CONFIG_KV.put(CATALOG_CACHE_KEY, JSON.stringify({ templates: catalog }), { expirationTtl: 3600 }); }
    catch { /* cache failure must not turn an available catalogue into a request failure */ }
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
    const tier = org?.plan_tier?.toLowerCase();
    return tier && ["free", "growth", "business", "enterprise"].includes(tier) ? tier : "free";
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

function normalizeShellCatalog(value: unknown): ShellCatalog | null {
  if (!value || typeof value !== "object") return null;
  const body = value as { project_templates?: unknown; agents?: unknown };
  if (!Array.isArray(body.project_templates) || !Array.isArray(body.agents) || body.project_templates.length > 500 || body.agents.length > 500) return null;
  const normalizeRows = (rows: unknown[], key: "kind" | "description") => rows.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.id) ||
        typeof row.name !== "string" || row.name.length > 160 || typeof row[key] !== "string" || row[key].length > 2000) return null;
    return { id: row.id, name: row.name, [key]: row[key] };
  });
  const projectTemplates = normalizeRows(body.project_templates, "kind");
  const agents = normalizeRows(body.agents, "description");
  if (projectTemplates.some((row) => row === null) || agents.some((row) => row === null)) return null;
  return {
    project_templates: projectTemplates as ShellCatalog["project_templates"],
    agents: agents as ShellCatalog["agents"],
  };
}

/** Unavailable (no binding, failed fetch) degrades to empty lists — this drives an informational
 *  panel, never an access decision, so a missing catalogue must never fail a manifest read. */
export async function loadShellCatalog(env: TemplateCatalogEnv): Promise<ShellCatalog> {
  const empty: ShellCatalog = { project_templates: [], agents: [] };
  if (env.NAELAO_CONFIG_KV) {
    try {
      const cached = normalizeShellCatalog(await env.NAELAO_CONFIG_KV.get(SHELL_CATALOG_CACHE_KEY, "json"));
      if (cached) return cached;
    } catch { /* unavailable/corrupt KV is a cache miss */ }
  }
  if (!env.AGENTS_WORKER) return empty;
  try {
    const resp = await env.AGENTS_WORKER.fetch(new Request("http://agents-worker/catalog/shell", { signal: AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS) }));
    if (!resp.ok) return empty;
    const catalog = normalizeShellCatalog(await readBoundedResponseJson<unknown>(resp, CATALOG_RESPONSE_MAX_BYTES));
    if (!catalog) return empty;
    if (env.NAELAO_CONFIG_KV) {
      await env.NAELAO_CONFIG_KV.put(SHELL_CATALOG_CACHE_KEY, JSON.stringify(catalog), { expirationTtl: 3600 });
    }
    return catalog;
  } catch {
    return empty;
  }
}
