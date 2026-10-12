/**
 * Composio "Connect Link" hosted-auth helpers — the mechanism behind a real "click Install"
 * connector experience (Claude/ChatGPT-style bundled connectors), for any of Composio's 500+
 * app toolkits (Twitter/X, LinkedIn, Instagram, TikTok, HubSpot, Google Ads, AgentMail, …).
 *
 * Unlike the bespoke per-platform OAuth2+PKCE flow in oauth.ts (Whop's own bring-your-account
 * app), Composio HOSTS the entire OAuth dance itself: Naelao holds one platform Composio API key
 * (mcp-hub's COMPOSIO_API_KEY, already wired — see catalogue.ts's header), creates a per-space
 * "connected account" against a pre-registered Composio "Auth Config" for the target app, and
 * sends the builder to Composio's own hosted consent page. Composio returns the browser to a
 * callback URL we control; the underlying OAuth token NEVER reaches Naelao — mcp-hub's tool-call
 * proxy references the connection by id only (resolveProviderApiKey / composioToolCall in
 * mcp-hub/src/index.ts), so there is no credential to vault on our side.
 *
 * `user_id` maps 1:1 to a Naelao space ("one Composio connected account per business"), namespaced
 * `naelao-space:{spaceId}` so Composio's own account listing is legible when Naelao support looks
 * at it. `auth_config_id` is NOT derivable from an app slug — it identifies a pre-created Composio
 * "Auth Config" (client id/secret + scopes registered once in the Composio dashboard) and is
 * supplied per connector via an env var name (ConnectorComposioSpec.auth_config_id_env), same
 * "env var NAME never a value in code" precedent as Whop's OAuth client id/secret.
 *
 * NOTE ON API SHAPE: Composio's REST base is `https://backend.composio.dev/api/v3`. The
 * documented SDK method is `composio.connectedAccounts.link(userId, authConfigId, {callbackUrl})`
 * (composio.dev/docs — Connected Accounts, 2026-07). The exact JSON field names of the raw REST
 * response were not exercised against a live API key in this pass (Composio's own docs pages
 * aren't fetchable unauthenticated) — both functions below check a small set of plausible field
 * names (snake_case and camelCase, optionally nested under `data`) rather than assuming one, and
 * throw an honest, specific error if none match. Confirm/narrow this once a real
 * `COMPOSIO_API_KEY` + Auth Config are provisioned, the same "verify once real access exists"
 * precedent as Whop's KYC field-name handling (CLAUDE.md item 51).
 */

const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3";

function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!obj) return "";
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

export interface ComposioLinkResult {
  redirect_url: string;
  connection_id: string;
}

/** Initiates a hosted Composio connection for one space. Never throws on a network/HTTP error
 *  silently — the caller (the /provider-connect/start route) surfaces a clear error to the
 *  builder rather than redirecting them into a broken flow. */
export async function startComposioLink(params: {
  apiKey: string;
  spaceId: string;
  authConfigId: string;
  callbackUrl: string;
}): Promise<ComposioLinkResult> {
  const resp = await fetch(`${COMPOSIO_API_BASE}/connected_accounts/link`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": params.apiKey },
    body: JSON.stringify({
      user_id: `naelao-space:${params.spaceId}`,
      auth_config_id: params.authConfigId,
      callback_url: params.callbackUrl,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await resp.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (!resp.ok) {
    const msg = pick(json, "error", "message") || `Composio connect-link failed: ${resp.status}`;
    throw new Error(msg);
  }
  const data = (json["data"] as Record<string, unknown> | undefined) ?? json;
  const redirectUrl = pick(data, "redirect_url", "redirectUrl");
  // Composio's own SDK source (composio/core/models/connected_accounts.py) confirms the real REST
  // response carries `connected_account_id` (snake_case, top-level) — preferred first; the other
  // names stay as defensive fallbacks in case a future API version reshapes this.
  const connectionId = pick(data, "connected_account_id", "connectedAccountId", "id", "connection_id");
  if (!redirectUrl || !connectionId) {
    throw new Error(
      "Composio connect-link response did not include a redirect_url/id — unexpected response shape, confirm against live API"
    );
  }
  return { redirect_url: redirectUrl, connection_id: connectionId };
}

export type ComposioConnectionStatus = "ACTIVE" | "INITIATED" | "FAILED" | "EXPIRED" | "REVOKED" | "UNKNOWN";

/** Polls the connection's real status rather than trusting the callback redirect alone — the
 *  return redirect proves the browser came back, not that the connection actually activated
 *  (same principle CLAUDE.md item 49 applied to Stripe Connect's charges_enabled poll). */
export async function getComposioConnectionStatus(apiKey: string, connectionId: string): Promise<ComposioConnectionStatus> {
  const resp = await fetch(`${COMPOSIO_API_BASE}/connected_accounts/${encodeURIComponent(connectionId)}`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return "UNKNOWN";
  const json = await resp.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const data = (json["data"] as Record<string, unknown> | undefined) ?? json;
  const status = pick(data, "status").toUpperCase();
  if (status === "ACTIVE" || status === "ENABLED") return "ACTIVE";
  if (status === "INITIATED" || status === "PENDING" || status === "INITIALIZING") return "INITIATED";
  if (status === "FAILED" || status === "ERROR") return "FAILED";
  if (status === "EXPIRED") return "EXPIRED";
  // REVOKED is a real, distinct Composio status (the end user disconnected the app on the
  // provider's side after it was once active) — surfaced as its own reason to the builder
  // (`connection_revoked`) rather than being lumped into the generic UNKNOWN/FAILED buckets.
  if (status === "REVOKED") return "REVOKED";
  return "UNKNOWN";
}

// ── Ticket (mirrors oauth.ts's issueOAuthTicket/consumeOAuthTicket precedent: a short-lived,
// single-use, server-held record rather than putting any state in a browser-navigable URL) ──

export interface ProviderConnectTicket {
  spaceId: string;
  tenantId: string;
  userId: string;
  returnUrl: string;
  platform: string;
  connectionId: string;
  /**
   * What `platform` was resolved to at START time (directory.ts). Carried rather than re-derived
   * in the callback so the two halves of a flow can never disagree — and because a directory app
   * has no catalogue row for the callback to look up at all.
   *
   * Optional: a ticket minted before this existed (10-minute TTL, so at most one deploy's worth)
   * still parses, and the callback falls back to catalogue lookup for those.
   */
  provider?: "composio" | "pipedream";
  /** The name the MCP server is registered under — the curated connector id, or a directory
   *  app's bare slug. */
  connectorId?: string;
  /** The provider toolkit slug used to confirm connection status. */
  appSlug?: string;
}

const PROVIDER_TICKET_TTL_SECONDS = 600;

/** Exported so the /provider-connect/start route can pre-generate the ticket id (it must appear
 *  in Composio's callback_url BEFORE the connection — and therefore connectionId — exists), then
 *  write the KV entry itself under this same key once startComposioLink returns. */
export function providerTicketKey(ticket: string): string {
  return `connector-provider-ticket:${ticket}`;
}

export async function issueProviderConnectTicket(kv: KVNamespace, data: ProviderConnectTicket): Promise<string> {
  const ticket = crypto.randomUUID();
  await kv.put(providerTicketKey(ticket), JSON.stringify(data), { expirationTtl: PROVIDER_TICKET_TTL_SECONDS });
  return ticket;
}

/** Single-use: a replayed callback URL (browser history, proxy log) can never redeem twice. */
export async function consumeProviderConnectTicket(kv: KVNamespace, ticket: string): Promise<ProviderConnectTicket | null> {
  const raw = await kv.get(providerTicketKey(ticket));
  if (!raw) return null;
  await kv.delete(providerTicketKey(ticket));
  try {
    return JSON.parse(raw) as ProviderConnectTicket;
  } catch {
    return null;
  }
}

// ── Directory: every app Composio can reach, not just the ones we curated ─────────────────────
//
// CONNECTOR_CATALOGUE is a hand-written list — good for the handful of apps a Launchpad business
// is steered toward, useless as an answer to "what CAN I connect?". Composio brokers 500+ app
// toolkits, and a user has no way to discover them from a file they can't see.
//
// The thing that used to make listing them pointless was `auth_config_id_env`: our connect flow
// needed a pre-registered Auth Config per app, created by hand in Composio's dashboard, so a
// listed-but-unconfigured app would have been a Connect button that 503s. `use_composio_managed_auth`
// removes that — Composio will run the OAuth dance with ITS OWN registered app credentials, and
// the auth config can be created over the API on first use. So every listed toolkit is genuinely
// connectable, and the curated list becomes a recommendation rather than a boundary.

/** Composio's auth-config API moved to v3.1 while toolkits stayed on v3 (their own reference
 *  docs, 2026-08). Keeping both explicit rather than assuming one base for everything. */
const COMPOSIO_API_V31 = "https://backend.composio.dev/api/v3.1";

export interface ComposioToolkit {
  slug: string;
  name: string;
  description?: string;
  logo?: string;
  categories: string[];
  /** "OAUTH2", "API_KEY", … when Composio reports it. Absent when it doesn't. */
  auth_scheme?: string;
}

export interface ComposioToolkitPage {
  toolkits: ComposioToolkit[];
  next_cursor?: string;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? pick(x as Record<string, unknown>, "slug", "name", "id") : ""))
    .filter((s): s is string => Boolean(s));
}

/**
 * One page of Composio's toolkit directory. Parsed defensively (same posture as the rest of this
 * file — see the header): a toolkit whose slug we can't read is skipped rather than surfaced as a
 * broken Connect button.
 */
export async function listComposioToolkits(params: {
  apiKey: string;
  search?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  /**
   * Composio's own documented ordering. `usage` ranks by how much its whole user base actually
   * reaches for a toolkit, which is a far better first page than the alphabetical default — that
   * opened the directory on "0codekit" and buried Gmail several hundred entries down.
   */
  sort?: "usage" | "alphabetically" | undefined;
}): Promise<ComposioToolkitPage> {
  const url = new URL(`${COMPOSIO_API_BASE}/toolkits`);
  if (params.search) url.searchParams.set("search", params.search);
  if (params.sort) url.searchParams.set("sort_by", params.sort);
  if (params.cursor) url.searchParams.set("cursor", params.cursor);
  url.searchParams.set("limit", String(Math.min(Math.max(params.limit ?? 50, 1), 100)));

  const resp = await fetch(url.toString(), {
    headers: { "x-api-key": params.apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  const json = await resp.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (!resp.ok) {
    throw new Error(pick(json, "error", "message") || `Composio toolkit listing failed: ${resp.status}`);
  }
  const items = (Array.isArray(json["items"]) ? json["items"] : Array.isArray(json["data"]) ? json["data"] : []) as Array<
    Record<string, unknown>
  >;
  const toolkits: ComposioToolkit[] = [];
  for (const raw of items) {
    const slug = pick(raw, "slug", "key", "name_slug");
    if (!slug) continue;
    const meta = (raw["meta"] as Record<string, unknown> | undefined) ?? raw;
    const description = pick(meta, "description", "short_description");
    const logo = pick(meta, "logo", "logo_url", "logoUrl", "icon");
    const authScheme = pick(raw, "auth_scheme", "authScheme") || strArray(raw["auth_schemes"])[0] || "";
    toolkits.push({
      slug,
      name: pick(raw, "name") || slug,
      ...(description ? { description } : {}),
      ...(logo ? { logo } : {}),
      categories: strArray(meta["categories"] ?? raw["categories"]),
      ...(authScheme ? { auth_scheme: authScheme } : {}),
    });
  }
  const nextCursor = pick(json, "next_cursor", "nextCursor");
  return { toolkits, ...(nextCursor ? { next_cursor: nextCursor } : {}) };
}

/**
 * One toolkit by its exact slug.
 *
 * Distinct from searching for it: `search` matches names and descriptions, so asking for
 * "instagram" can return a page of adjacent tools with the one we actually want past the limit.
 * That is precisely how the curated logo lookup silently missed several apps whose slug we already
 * knew exactly. Returns null rather than throwing when Composio doesn't have it — a missing logo
 * must never be an error.
 */
export async function getComposioToolkit(params: {
  apiKey: string;
  slug: string;
}): Promise<ComposioToolkit | null> {
  const resp = await fetch(`${COMPOSIO_API_BASE}/toolkits/${encodeURIComponent(params.slug)}`, {
    headers: { "x-api-key": params.apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return null;
  const raw = await resp.json<Record<string, unknown>>().catch(() => null);
  if (!raw) return null;
  const slug = pick(raw, "slug", "key", "name_slug") || params.slug;
  const meta = (raw["meta"] as Record<string, unknown> | undefined) ?? raw;
  const description = pick(meta, "description", "short_description");
  const logo = pick(meta, "logo", "logo_url", "logoUrl", "icon");
  return {
    slug,
    name: pick(raw, "name") || slug,
    ...(description ? { description } : {}),
    ...(logo ? { logo } : {}),
    categories: strArray(meta["categories"] ?? raw["categories"]),
  };
}

/**
 * Get (creating if needed) an Auth Config for a toolkit using COMPOSIO'S OWN registered OAuth
 * app credentials, so connecting an app needs no dashboard work from us first. This is what makes
 * the whole directory connectable rather than browsable.
 *
 * Idempotent by caching the resulting `ac_…` id in KV, keyed by toolkit — creating a second one
 * for the same toolkit would work but would quietly accumulate config objects in the Composio
 * account, and the two would drift once one of them was edited by hand.
 *
 * Throws (rather than returning a placeholder) when Composio has no managed app for the toolkit —
 * a real, specific failure the caller surfaces to the user, not a Connect button that dead-ends.
 */
export async function ensureComposioAuthConfig(params: {
  apiKey: string;
  toolkitSlug: string;
  cache?: KVNamespace | undefined;
}): Promise<string> {
  const cacheKey = `composio-auth-config:${params.toolkitSlug.toLowerCase()}`;
  if (params.cache) {
    const cached = await params.cache.get(cacheKey);
    if (cached) return cached;
  }

  const resp = await fetch(`${COMPOSIO_API_V31}/auth_configs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": params.apiKey },
    body: JSON.stringify({
      toolkit: { slug: params.toolkitSlug },
      auth_config: { type: "use_composio_managed_auth", name: `naelao-${params.toolkitSlug}` },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await resp.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (!resp.ok) {
    const err = (json["error"] as Record<string, unknown> | undefined) ?? json;
    throw new Error(pick(err, "message", "error") || `Composio auth-config creation failed: ${resp.status}`);
  }
  const authConfig = (json["auth_config"] as Record<string, unknown> | undefined) ?? (json["data"] as Record<string, unknown> | undefined) ?? json;
  const id = pick(authConfig, "id", "auth_config_id", "authConfigId");
  if (!id) {
    throw new Error(`Composio did not return an auth config id for ${params.toolkitSlug}`);
  }
  // Cached without an expiry: an auth config is a durable object in the Composio account, and a
  // stale-but-valid id is exactly what we want on a later connect.
  if (params.cache) await params.cache.put(cacheKey, id);
  return id;
}
