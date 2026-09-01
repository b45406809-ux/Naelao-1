/**
 * The connector DIRECTORY — everything a business could connect, not just what we curated.
 *
 * `CONNECTOR_CATALOGUE` (catalogue.ts) is a hand-written list of about a dozen apps. That is the
 * right shape for a RECOMMENDATION — the handful a Launchpad business is steered toward during
 * onboarding — and the wrong shape for an ANSWER to "what can I connect?". Composio (500+ toolkits)
 * brokers almost anything a business uses.
 *
 * `use_composio_managed_auth` lets Composio run the OAuth dance with its OWN app credentials,
 * and the config can be created over the API on first connect (composio.ts's
 * `ensureComposioAuthConfig`). So a listed toolkit is genuinely connectable.
 *
 * The model is: the curated catalogue is what we RECOMMEND, the directory is what is POSSIBLE,
 * and both connect through the same hosted flow the shell already has a button for.
 *
 * Ids are namespaced `composio:{slug}` (`composio:notion`, `composio:slack`) so a directory app
 * can never be confused with a curated connector, and so the connect routes can tell from the id
 * alone which path to take. A curated connector always wins: if we have a real MCP shim and real
 * declared operations for an app, that is better than a generic brokered one.
 */

import { CONNECTOR_CATALOGUE, getConnector, type ConnectorCategory } from "./catalogue.js";
import { listComposioToolkits, getComposioToolkit } from "./composio.js";

export type DirectoryProvider = "composio";

export interface DirectoryApp {
  /** `composio:{slug}` — what the connect routes take as `:platform`. */
  id: string;
  provider: DirectoryProvider;
  slug: string;
  name: string;
  description?: string;
  logo?: string;
  categories: string[];
  /** Whether connecting runs a hosted OAuth consent flow or asks for a key on the provider's
   *  own page. Reported as the provider states it; absent when it doesn't say. */
  auth?: string;
  /** True when this app is ALSO a curated connector — the UI should point at that one, which has
   *  real declared operations and (sometimes) a purpose-built MCP shim. */
  curated_as?: string;
  /**
   * Position within the provider's own popularity ordering, 0 = most popular. Present only in
   * `sort: "popular"` mode and only for a provider that actually ranks.
   */
  rank?: number;
}

/**
 * How the merged directory is ordered.
 *
 * `popular` is the default a browsing user should see: alphabetical order opens the directory on
 * "0codekit" and buries Gmail several hundred entries down, which makes a genuinely rich catalogue
 * look like junk. Composio ranks server-side (`sort_by=usage`, its own documented parameter over
 * its whole user base).
 */
export type DirectorySort = "popular" | "name";

export function directoryAppId(provider: DirectoryProvider, slug: string): string {
  return `${provider}:${slug}`;
}

/** Parse a `composio:{slug}` id. Returns null for a curated connector id (no colon), which is
 *  how the connect routes decide which resolution path to take. */
export function parseDirectoryAppId(id: string): { provider: DirectoryProvider; slug: string } | null {
  const idx = id.indexOf(":");
  if (idx <= 0) return null;
  const provider = id.slice(0, idx);
  const slug = id.slice(idx + 1);
  if (!slug) return null;
  if (provider !== "composio") return null;
  return { provider: "composio", slug };
}

/** `composio:{slug}` → curated connector id, built once per isolate from the catalogue's own
 *  declarations. Derived rather than hand-maintained, so a new curated connector is picked up
 *  here automatically instead of silently producing a duplicate directory entry. */
let curatedByProviderSlug: Map<string, string> | null = null;
function curatedIndex(): Map<string, string> {
  if (curatedByProviderSlug) return curatedByProviderSlug;
  const map = new Map<string, string>();
  for (const c of CONNECTOR_CATALOGUE) {
    if (c.composio) map.set(directoryAppId("composio", c.composio.toolkit_slug.toLowerCase()), c.id);
  }
  curatedByProviderSlug = map;
  return map;
}

/**
 * The same index keyed on the bare slug, so a curated connector still matches the provider's
 * entry for the same app.
 */
let curatedBySlug: Map<string, string> | null = null;
function curatedSlugIndex(): Map<string, string> {
  if (curatedBySlug) return curatedBySlug;
  const map = new Map<string, string>();
  for (const c of CONNECTOR_CATALOGUE) {
    const slug = c.composio?.toolkit_slug;
    if (slug) map.set(slug.toLowerCase(), c.id);
  }
  curatedBySlug = map;
  return map;
}

/**
 * Does a curated connector already cover this app? Matched on the provider slug the curated entry
 * itself declares.
 */
function curatedIdFor(provider: DirectoryProvider, slug: string): string | undefined {
  const id =
    curatedIndex().get(directoryAppId(provider, slug.toLowerCase())) ??
    curatedSlugIndex().get(slug.toLowerCase());
  if (id && getConnector(id)?.status === "available") return id;
  return undefined;
}

export interface DirectoryPage {
  apps: DirectoryApp[];
  next_cursor?: string;
  /** Which providers actually answered. */
  providers: Array<{ provider: DirectoryProvider; available: boolean; reason?: string }>;
}

export interface DirectoryEnv {
  COMPOSIO_API_KEY?: string | undefined;
}

/**
 * One page of the directory.
 */
export async function listDirectory(
  env: DirectoryEnv,
  opts: {
    search?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
    sort?: DirectorySort | undefined;
  } = {}
): Promise<DirectoryPage> {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const sort: DirectorySort = opts.sort ?? "popular";
  const cursors = decodeCursor(opts.cursor);
  const providers: DirectoryPage["providers"] = [];
  const apps: DirectoryApp[] = [];
  const nextCursors: Record<string, string> = {};

  const composioKey = env.COMPOSIO_API_KEY;

  if (!composioKey) {
    providers.push({ provider: "composio", available: false, reason: "not_configured" });
    return { apps: [], providers };
  }

  try {
    if (cursors.composio !== "END") {
      const page = await listComposioToolkits({
        apiKey: composioKey,
        search: opts.search,
        cursor: cursors.composio,
        limit,
        sort: sort === "popular" ? "usage" : "alphabetically",
      });

      providers.push({ provider: "composio", available: true });
      if (page) {
        page.toolkits.forEach((t, i) => {
          if (t.slug.toLowerCase() === "composio") return;
          const app = toDirectoryApp("composio", t.slug, t.name, t.description, t.logo, t.categories, t.auth_scheme);
          if (sort === "popular") app.rank = i;
          apps.push(app);
        });
        if (page.next_cursor) nextCursors["composio"] = page.next_cursor;
      }
    } else {
      providers.push({ provider: "composio", available: true });
    }
  } catch (err) {
    providers.push({ provider: "composio", available: false, reason: (err as Error)?.message ?? "unavailable" });
  }

  const exactlyCurated = (a: DirectoryApp) => curatedIndex().has(directoryAppId(a.provider, a.slug.toLowerCase()));
  const preference = (a: DirectoryApp | undefined) =>
    a === undefined ? -1 : exactlyCurated(a) ? 2 : a.curated_as ? 1 : 0;
  const bySlug = new Map<string, DirectoryApp>();
  for (const a of apps) {
    const key = a.slug.toLowerCase();
    if (preference(a) > preference(bySlug.get(key))) bySlug.set(key, a);
  }
  const deduped = [...bySlug.values()];
  if (sort === "popular") {
    deduped.sort((a, b) => {
      const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
      const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
      return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
    });
  } else {
    deduped.sort((a, b) => a.name.localeCompare(b.name));
  }

  const nextCursor = Object.keys(nextCursors).length > 0 ? encodeCursor(nextCursors) : undefined;
  return { apps: deduped, ...(nextCursor ? { next_cursor: nextCursor } : {}), providers };
}

function toDirectoryApp(
  provider: DirectoryProvider,
  slug: string,
  name: string,
  description: string | undefined,
  logo: string | undefined,
  categories: string[],
  auth: string | undefined
): DirectoryApp {
  const curated = curatedIdFor(provider, slug);
  return {
    id: directoryAppId(provider, slug),
    provider,
    slug,
    name,
    ...(description ? { description } : {}),
    ...(logo ? { logo } : {}),
    categories,
    ...(auth ? { auth } : {}),
    ...(curated ? { curated_as: curated } : {}),
  };
}

/** Per-provider cursors carried as one opaque token so the UI has a single "next page" control. */
function encodeCursor(map: Record<string, string>): string {
  return btoa(JSON.stringify(map));
}
function decodeCursor(cursor: string | undefined): { composio?: string } {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(atob(cursor)) as Record<string, unknown>;
    const out: { composio?: string } = {};
    out.composio = typeof parsed["composio"] === "string" ? (parsed["composio"] as string) : "END";
    return out;
  } catch {
    return {};
  }
}

/**
 * Real logos for the CURATED connectors.
 */
export async function curatedLogos(
  env: DirectoryEnv & { cache?: KVNamespace | undefined }
): Promise<Record<string, string>> {
  const CACHE_KEY = "connector-curated-logos:v2";
  if (env.cache) {
    const hit = await env.cache.get(CACHE_KEY);
    if (hit) {
      try {
        return JSON.parse(hit) as Record<string, string>;
      } catch {
        /* fall through and rebuild */
      }
    }
  }

  const out: Record<string, string> = {};
  const lookups = CONNECTOR_CATALOGUE.filter((c) => c.composio).map(async (c) => {
    const slug = (c.composio?.toolkit_slug ?? "").toLowerCase();
    if (!slug) return;
    try {
      if (c.composio && env.COMPOSIO_API_KEY) {
        const hit = await getComposioToolkit({ apiKey: env.COMPOSIO_API_KEY, slug });
        if (hit?.logo) out[c.id] = hit.logo;
      }
    } catch {
      // One provider hiccup costs one logo, not the whole grid.
    }
  });
  await Promise.allSettled(lookups);

  if (env.cache) {
    await env.cache.put(CACHE_KEY, JSON.stringify(out), { expirationTtl: 86_400 });
  }
  return out;
}

/** Categories the curated catalogue uses, for a UI that wants to filter both lists together. */
export function curatedCategories(): ConnectorCategory[] {
  return [
    "course_product", "newsletter", "community", "booking", "marketplace", "freelance",
    "social", "voice", "support", "content_gen", "crm", "ads", "email", "productivity",
  ];
}

/**
 * Resolve what `:platform` means for a connect flow.
 *
 * A curated id always wins — it carries real declared operations, and sometimes a purpose-built
 * MCP shim, which a generically brokered connection does not. Only when the id is not curated is
 * it read as a `composio:{slug}` directory app.
 */
export function resolveConnectTarget(platform: string):
  | { kind: "curated"; id: string }
  | { kind: "directory"; provider: DirectoryProvider; slug: string }
  | null {
  if (getConnector(platform)) return { kind: "curated", id: platform };
  const parsed = parseDirectoryAppId(platform);
  if (!parsed) return null;
  const curated = curatedIdFor(parsed.provider, parsed.slug);
  if (curated && getConnector(curated)?.status === "available") return { kind: "curated", id: curated };
  return { kind: "directory", provider: parsed.provider, slug: parsed.slug };
}
