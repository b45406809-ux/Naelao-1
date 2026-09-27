/** Composio-backed SaaS directory. Curated connectors remain recommendations; the managed
 * directory makes every supported toolkit discoverable without adding source-code entries. */
import { CONNECTOR_CATALOGUE, getConnector, type ConnectorCategory } from "./catalogue.js";
import { listComposioToolkits, getComposioToolkit } from "./composio.js";

export type DirectoryProvider = "composio";
export type DirectorySort = "popular" | "name";
export interface DirectoryApp { id: string; provider: DirectoryProvider; slug: string; name: string; description?: string; logo?: string; categories: string[]; auth?: string; curated_as?: string; rank?: number }
export interface DirectoryPage { apps: DirectoryApp[]; next_cursor?: string; providers: Array<{ provider: DirectoryProvider; available: boolean; reason?: string }> }
export interface DirectoryEnv { COMPOSIO_API_KEY?: string }
export function directoryAppId(_provider: DirectoryProvider, slug: string): string { return `composio:${slug}`; }
export function parseDirectoryAppId(id: string): { provider: DirectoryProvider; slug: string } | null {
  return id.startsWith("composio:") && id.length > 9 ? { provider: "composio", slug: id.slice(9) } : null;
}
function curatedId(slug: string): string | undefined {
  return CONNECTOR_CATALOGUE.find((c) => c.composio?.toolkit_slug.toLowerCase() === slug.toLowerCase() && c.status === "available")?.id;
}
export async function listDirectory(env: DirectoryEnv, opts: { search?: string | undefined; cursor?: string | undefined; limit?: number; sort?: DirectorySort } = {}): Promise<DirectoryPage> {
  if (!env.COMPOSIO_API_KEY) return { apps: [], providers: [{ provider: "composio", available: false, reason: "not_configured" }] };
  try {
    const page = await listComposioToolkits({ apiKey: env.COMPOSIO_API_KEY, search: opts.search, cursor: opts.cursor, limit: Math.min(Math.max(opts.limit ?? 40, 1), 100), sort: opts.sort === "name" ? "alphabetically" : "usage" });
    const apps = page.toolkits.filter((t) => t.slug.toLowerCase() !== "composio").map((t, rank) => ({ id: directoryAppId("composio", t.slug), provider: "composio" as const, slug: t.slug, name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.logo ? { logo: t.logo } : {}), categories: t.categories, ...(t.auth_scheme ? { auth: t.auth_scheme } : {}), ...(curatedId(t.slug) ? { curated_as: curatedId(t.slug)! } : {}), ...(opts.sort !== "name" ? { rank } : {}) }));
    return { apps, ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}), providers: [{ provider: "composio", available: true }] };
  } catch (error) {
    return { apps: [], providers: [{ provider: "composio", available: false, reason: (error as Error).message }] };
  }
}
export async function curatedLogos(env: DirectoryEnv & { cache?: KVNamespace }): Promise<Record<string, string>> {
  const key = "connector-curated-logos:v3";
  const cached = await env.cache?.get(key, "json").catch(() => null) as Record<string, string> | null;
  if (cached) return cached;
  const out: Record<string, string> = {};
  if (env.COMPOSIO_API_KEY) await Promise.allSettled(CONNECTOR_CATALOGUE.filter((c) => c.composio).map(async (c) => {
    const toolkit = await getComposioToolkit({ apiKey: env.COMPOSIO_API_KEY!, slug: c.composio!.toolkit_slug });
    if (toolkit?.logo) out[c.id] = toolkit.logo;
  }));
  await env.cache?.put(key, JSON.stringify(out), { expirationTtl: 86_400 });
  return out;
}
export function curatedCategories(): ConnectorCategory[] { return ["course_product", "newsletter", "community", "booking", "marketplace", "freelance", "social", "voice", "support", "content_gen", "crm", "ads", "email", "productivity"]; }
export function resolveConnectTarget(platform: string): { kind: "curated"; id: string } | { kind: "directory"; provider: DirectoryProvider; slug: string } | null {
  if (getConnector(platform)) return { kind: "curated", id: platform };
  const parsed = parseDirectoryAppId(platform); if (!parsed) return null;
  const curated = curatedId(parsed.slug); return curated ? { kind: "curated", id: curated } : { kind: "directory", ...parsed };
}
