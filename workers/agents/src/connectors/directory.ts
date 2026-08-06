/**
 * The connector DIRECTORY — everything a business could connect, not just what we curated.
 *
 * `CONNECTOR_CATALOGUE` (catalogue.ts) is a hand-written list of about a dozen apps. That is the
 * right shape for a RECOMMENDATION — the handful a Launchpad business is steered toward during
 * onboarding — and the wrong shape for an ANSWER to "what can I connect?". Between them, Composio
 * (500+ toolkits) and Pipedream (3,000+ apps) already broker almost anything a small business
 * uses, and a user had no way to see any of it: connecting an uncurated app meant someone adding
 * a row to a TypeScript file.
 *
 * Two things made that a real boundary rather than a missing screen, and both are now gone:
 *
 *   - Composio needed a pre-registered "Auth Config" per app (`auth_config_id_env`), created by
 *     hand in their dashboard. `use_composio_managed_auth` lets Composio run the OAuth dance with
 *     its OWN app credentials, and the config can be created over the API on first connect
 *     (composio.ts's `ensureComposioAuthConfig`). So a listed toolkit is genuinely connectable.
 *   - Pipedream never needed one — Connect takes an app slug directly. Only the listing was
 *     missing.
 *
 * So the model is now: the curated catalogue is what we RECOMMEND, the directory is what is
 * POSSIBLE, and both connect through the same hosted flow the shell already has a button for.
 *
 * Ids are namespaced `{provider}:{slug}` (`composio:notion`, `pipedream:slack`) so a directory app
 * can never be confused with a curated connector, and so the connect routes can tell from the id
 * alone which path to take. A curated connector always wins: if we have a real MCP shim and real
 * declared operations for an app, that is better than a generic brokered one.
 */

import { CONNECTOR_CATALOGUE, getConnector, type ConnectorCategory } from "./catalogue.js";
import { listComposioToolkits } from "./composio.js";
import { listPipedreamApps } from "./pipedream.js";

export type DirectoryProvider = "composio" | "pipedream";

export interface DirectoryApp {
  /** `{provider}:{slug}` — what the connect routes take as `:platform`. */
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
}

export function directoryAppId(provider: DirectoryProvider, slug: string): string {
  return `${provider}:${slug}`;
}

/** Parse a `{provider}:{slug}` id. Returns null for a curated connector id (no colon), which is
 *  how the connect routes decide which resolution path to take. */
export function parseDirectoryAppId(id: string): { provider: DirectoryProvider; slug: string } | null {
  const idx = id.indexOf(":");
  if (idx <= 0) return null;
  const provider = id.slice(0, idx);
  const slug = id.slice(idx + 1);
  if (!slug) return null;
  if (provider !== "composio" && provider !== "pipedream") return null;
  return { provider, slug };
}

/** `{provider}:{slug}` → curated connector id, built once per isolate from the catalogue's own
 *  declarations. Derived rather than hand-maintained, so a new curated connector is picked up
 *  here automatically instead of silently producing a duplicate directory entry. */
let curatedByProviderSlug: Map<string, string> | null = null;
function curatedIndex(): Map<string, string> {
  if (curatedByProviderSlug) return curatedByProviderSlug;
  const map = new Map<string, string>();
  for (const c of CONNECTOR_CATALOGUE) {
    if (c.composio) map.set(directoryAppId("composio", c.composio.toolkit_slug.toLowerCase()), c.id);
    else if (c.pipedream) map.set(directoryAppId("pipedream", c.pipedream.app_slug.toLowerCase()), c.id);
  }
  curatedByProviderSlug = map;
  return map;
}

/**
 * Does a curated connector already cover this app? Matched on the provider slug the curated entry
 * itself declares — never on a fuzzy name match, which would mislabel (say) a "Notion Calendar"
 * toolkit as our Notion connector.
 */
function curatedIdFor(provider: DirectoryProvider, slug: string): string | undefined {
  const id = curatedIndex().get(directoryAppId(provider, slug.toLowerCase()));
  // Only an AVAILABLE connector counts — `curated_as` means "there is a better path for this app",
  // which isn't true of a coming_soon entry. Marking one would hide a genuinely connectable app
  // from the directory in favour of a button that refuses. Same rule as resolveConnectTarget.
  if (id && getConnector(id)?.status === "available") return id;
  return undefined;
}

export interface DirectoryPage {
  apps: DirectoryApp[];
  next_cursor?: string;
  /** Which providers actually answered. A provider with no key configured is reported as
   *  unavailable rather than silently contributing nothing — "we found 40 apps" reads very
   *  differently when half the directory is switched off. */
  providers: Array<{ provider: DirectoryProvider; available: boolean; reason?: string }>;
}

export interface DirectoryEnv {
  COMPOSIO_API_KEY?: string | undefined;
  PIPEDREAM_CLIENT_ID?: string | undefined;
  PIPEDREAM_CLIENT_SECRET?: string | undefined;
}

/**
 * One page of the merged directory.
 *
 * Both providers are queried in parallel and either one failing degrades to "that provider is
 * unavailable" rather than failing the whole listing — a Composio outage should not hide
 * Pipedream's 3,000 apps. Cursors are per-provider and combined into one opaque token, so paging
 * stays a single control in the UI.
 */
export async function listDirectory(
  env: DirectoryEnv,
  opts: { search?: string | undefined; cursor?: string | undefined; limit?: number | undefined } = {}
): Promise<DirectoryPage> {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const cursors = decodeCursor(opts.cursor);
  const providers: DirectoryPage["providers"] = [];
  const apps: DirectoryApp[] = [];
  const nextCursors: Record<string, string> = {};

  const composioKey = env.COMPOSIO_API_KEY;
  const pdId = env.PIPEDREAM_CLIENT_ID;
  const pdSecret = env.PIPEDREAM_CLIENT_SECRET;

  const [composioRes, pipedreamRes] = await Promise.allSettled([
    composioKey && cursors.composio !== "END"
      ? listComposioToolkits({ apiKey: composioKey, search: opts.search, cursor: cursors.composio, limit })
      : Promise.resolve(null),
    pdId && pdSecret && cursors.pipedream !== "END"
      ? listPipedreamApps({ clientId: pdId, clientSecret: pdSecret, search: opts.search, cursor: cursors.pipedream, limit })
      : Promise.resolve(null),
  ]);

  if (!composioKey) {
    providers.push({ provider: "composio", available: false, reason: "not_configured" });
  } else if (composioRes.status === "rejected") {
    providers.push({ provider: "composio", available: false, reason: (composioRes.reason as Error)?.message ?? "unavailable" });
  } else {
    providers.push({ provider: "composio", available: true });
    const page = composioRes.value;
    if (page) {
      for (const t of page.toolkits) {
        apps.push(toDirectoryApp("composio", t.slug, t.name, t.description, t.logo, t.categories, t.auth_scheme));
      }
      if (page.next_cursor) nextCursors["composio"] = page.next_cursor;
    }
  }

  if (!pdId || !pdSecret) {
    providers.push({ provider: "pipedream", available: false, reason: "not_configured" });
  } else if (pipedreamRes.status === "rejected") {
    providers.push({ provider: "pipedream", available: false, reason: (pipedreamRes.reason as Error)?.message ?? "unavailable" });
  } else {
    providers.push({ provider: "pipedream", available: true });
    const page = pipedreamRes.value;
    if (page) {
      for (const a of page.apps) {
        apps.push(toDirectoryApp("pipedream", a.slug, a.name, a.description, a.logo, a.categories, a.auth_type));
      }
      if (page.next_cursor) nextCursors["pipedream"] = page.next_cursor;
    }
  }

  // Same app brokered by BOTH providers: keep one, and keep the right one. Preferring whichever
  // arrived first would silently drop the curated match when the app is curated through the other
  // provider (Notion is a curated Pipedream connector and also a Composio toolkit) — the user
  // would then be offered a generic brokered connection instead of the one with real declared
  // operations. So a curated entry always wins; otherwise first-seen is a fine tie-break.
  const bySlug = new Map<string, DirectoryApp>();
  for (const a of apps) {
    const key = a.slug.toLowerCase();
    const existing = bySlug.get(key);
    if (!existing || (!existing.curated_as && a.curated_as)) bySlug.set(key, a);
  }
  const deduped = [...bySlug.values()];
  deduped.sort((a, b) => a.name.localeCompare(b.name));

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
function decodeCursor(cursor: string | undefined): { composio?: string; pipedream?: string } {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(atob(cursor)) as Record<string, unknown>;
    const out: { composio?: string; pipedream?: string } = {};
    // A provider absent from a non-empty cursor has already run out of pages — mark it done so
    // the next page doesn't restart it from the beginning and duplicate its whole first page.
    out.composio = typeof parsed["composio"] === "string" ? (parsed["composio"] as string) : "END";
    out.pipedream = typeof parsed["pipedream"] === "string" ? (parsed["pipedream"] as string) : "END";
    return out;
  } catch {
    return {};
  }
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
 * it read as a `{provider}:{slug}` directory app.
 */
export function resolveConnectTarget(platform: string):
  | { kind: "curated"; id: string }
  | { kind: "directory"; provider: DirectoryProvider; slug: string }
  | null {
  if (getConnector(platform)) return { kind: "curated", id: platform };
  const parsed = parseDirectoryAppId(platform);
  if (!parsed) return null;
  // A directory id that names an app we DO curate is redirected to the curated connector, so two
  // routes can't produce two differently-named MCP servers for the same app in one space.
  //
  // But only when that connector is actually AVAILABLE. Several catalogue entries are marked
  // coming_soon purely because we hadn't provisioned an Auth Config for them by hand — a reason
  // managed auth has since removed. Redirecting to one of those would turn a genuinely
  // connectable app into a "coming soon" refusal, which is the exact dead end a browsable
  // directory must not have.
  const curated = curatedIdFor(parsed.provider, parsed.slug);
  if (curated && getConnector(curated)?.status === "available") return { kind: "curated", id: curated };
  return { kind: "directory", provider: parsed.provider, slug: parsed.slug };
}
