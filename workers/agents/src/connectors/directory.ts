/** Unified hosted-connector directory. Composio remains the default for overlaps; Pipedream is
 * included only when its verified app allowlist and platform credentials are configured. */
import { CONNECTOR_CATALOGUE, getConnector, type ConnectorCategory } from "./catalogue.js";
import { listComposioToolkits, getComposioToolkit } from "./composio.js";
import { listPipedreamApps, type PipedreamConnectEnv } from "./pipedream.js";

export type DirectoryProvider = "composio" | "pipedream";
export type DirectorySort = "popular" | "name";
export interface DirectoryApp { id: string; provider: DirectoryProvider; slug: string; name: string; description?: string; logo?: string; categories: string[]; auth?: string; curated_as?: string; rank?: number; connected?: boolean; connected_provider?: DirectoryProvider | "direct" }
export interface DirectoryPage { apps: DirectoryApp[]; next_cursor?: string | undefined; providers: Array<{ provider: DirectoryProvider; available: boolean; reason?: string }> }
export interface DirectoryEnv extends PipedreamConnectEnv { COMPOSIO_API_KEY?: string }
export function directoryAppId(provider: DirectoryProvider, slug: string): string { return `${provider}:${slug}`; }
export function parseDirectoryAppId(id: string): { provider: DirectoryProvider; slug: string } | null {
  const match = /^(composio|pipedream):([a-z0-9][a-z0-9._-]{0,127})$/i.exec(id);
  return match ? { provider: match[1]!.toLowerCase() as DirectoryProvider, slug: match[2]!.toLowerCase() } : null;
}
function curatedId(slug: string): string | undefined {
  return CONNECTOR_CATALOGUE.find((c) => (c.composio?.toolkit_slug.toLowerCase() === slug.toLowerCase() || c.pipedream?.app_slug.toLowerCase() === slug.toLowerCase()) && c.status === "available")?.id;
}
interface CursorState { composio?: string | undefined; pipedream?: string | undefined }
function decodeCursor(cursor?: string): CursorState {
  if (!cursor) return {};
  try {
    const normalized = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(normalized)) as CursorState;
    if (parsed && typeof parsed === "object") return parsed;
  } catch { /* previous cursors were raw Composio cursors */ }
  return { composio: cursor };
}
function encodeCursor(cursor: CursorState): string | undefined {
  if (!cursor.composio && !cursor.pipedream) return undefined;
  return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function listDirectory(env: DirectoryEnv, opts: { search?: string | undefined; cursor?: string | undefined; limit?: number; sort?: DirectorySort } = {}): Promise<DirectoryPage> {
  const state = decodeCursor(opts.cursor);
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const providers: DirectoryPage["providers"] = [];
  const requests: Promise<void>[] = [];
  let composioApps: DirectoryApp[] = [];
  let composioNext: string | undefined;
  if (env.COMPOSIO_API_KEY && (opts.cursor === undefined || state.composio !== undefined)) {
    requests.push((async () => {
      try {
        const page = await listComposioToolkits({ apiKey: env.COMPOSIO_API_KEY!, search: opts.search, cursor: state.composio, limit, sort: opts.sort === "name" ? "alphabetically" : "usage" });
        composioApps = page.toolkits.filter((t) => t.slug.toLowerCase() !== "composio").map((t, rank) => ({ id: directoryAppId("composio", t.slug), provider: "composio", slug: t.slug.toLowerCase(), name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.logo ? { logo: t.logo } : {}), categories: t.categories, ...(t.auth_scheme ? { auth: t.auth_scheme } : {}), ...(curatedId(t.slug) ? { curated_as: curatedId(t.slug)! } : {}), ...(opts.sort !== "name" ? { rank } : {}) }));
        composioNext = page.next_cursor;
        providers.push({ provider: "composio", available: true });
      } catch (error) { providers.push({ provider: "composio", available: false, reason: (error as Error).message }); }
    })());
  } else providers.push({ provider: "composio", available: Boolean(env.COMPOSIO_API_KEY), ...(!env.COMPOSIO_API_KEY ? { reason: "not_configured" } : {}) });

  let pipedreamApps: DirectoryApp[] = [];
  let pipedreamNext: string | undefined;
  const pipedreamConfigured = Boolean(env.PIPEDREAM_CLIENT_ID && env.PIPEDREAM_CLIENT_SECRET && env.PIPEDREAM_SUPPORTED_APPS?.trim());
  if (pipedreamConfigured && (opts.cursor === undefined || state.pipedream !== undefined)) {
    requests.push((async () => {
      try {
        const page = await listPipedreamApps(env, { search: opts.search, after: state.pipedream, limit, sort: opts.sort });
        pipedreamApps = page.apps.map((a) => ({ id: directoryAppId("pipedream", a.slug), provider: "pipedream", slug: a.slug, name: a.name, ...(a.description ? { description: a.description } : {}), ...(a.logo ? { logo: a.logo } : {}), categories: a.categories, ...(curatedId(a.slug) ? { curated_as: curatedId(a.slug)! } : {}) }));
        pipedreamNext = page.nextCursor;
        providers.push({ provider: "pipedream", available: true });
      } catch (error) { providers.push({ provider: "pipedream", available: false, reason: (error as Error).message }); }
    })());
  } else providers.push({ provider: "pipedream", available: pipedreamConfigured, ...(!pipedreamConfigured ? { reason: "not_configured" } : {}) });
  await Promise.all(requests);

  // One card per app slug. Prefer Composio when both providers support it; users can explicitly
  // choose Pipedream at connect time, which is the only way to create a different provider pin.
  const seen = new Set<string>();
  const apps = [...composioApps, ...pipedreamApps].filter((app) => {
    if (seen.has(app.slug)) return false;
    seen.add(app.slug);
    return true;
  });
  if (opts.sort === "name") apps.sort((a, b) => a.name.localeCompare(b.name));
  return { apps, ...(encodeCursor({ composio: composioNext, pipedream: pipedreamNext }) ? { next_cursor: encodeCursor({ composio: composioNext, pipedream: pipedreamNext }) } : {}), providers };
}

export async function curatedLogos(env: DirectoryEnv & { cache?: KVNamespace }): Promise<Record<string, string>> {
  const key = "connector-curated-logos:v4";
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
