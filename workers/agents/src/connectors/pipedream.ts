/**
 * Pipedream Connect hosted-auth helpers — the second "click Install" hosted-connect provider
 * alongside composio.ts, behind the SAME /provider-connect/start + /provider-connect/callback
 * routes and the same shell UI (zero frontend changes to add a Pipedream-routed connector).
 *
 * VERIFIED auth model (2026-07, via Pipedream's own docs — this corrects an earlier assumption
 * that a single static PIPEDREAM_API_KEY was sufficient, mirrored in mcp-hub's env comment):
 * ALL Pipedream REST API access (including Connect) is OAuth client_credentials — there is no
 * "simple API key" path. A workspace admin creates an OAuth client (client_id/client_secret) in
 * the Pipedream dashboard; the client exchanges those for a short-lived (1hr) access token via
 * POST https://api.pipedream.com/v1/oauth/token, then calls the Connect API as
 * `Authorization: Bearer <access_token>`.
 *
 * Flow: startPipedreamConnect creates a Connect token scoped to one external_user_id (Naelao
 * space) + one app, and passes a `success_redirect_uri` pointing back at OUR
 * /provider-connect/callback (same "the provider redirects the browser back to us" shape as
 * Composio's callback_url) — Pipedream's hosted Connect Link page then handles the real OAuth
 * dance with the target app. The callback route (agents worker index.ts) polls
 * getPipedreamAccountStatus for a REAL active connected account before registering the MCP
 * server — never trusts the redirect alone (same rule as Composio / Stripe Connect's
 * charges_enabled poll, CLAUDE.md item 49).
 *
 * NOTE ON UNVERIFIED SHAPE: the exact JSON field names of the /accounts listing response were not
 * exercised against a live Pipedream project in this pass (same "confirm once real access exists"
 * precedent as composio.ts / Whop's KYC field-name handling) — the status check below tries a
 * small set of plausible field/status names and fails closed (never registers) on anything it
 * doesn't recognize.
 */

const PIPEDREAM_API_BASE = "https://api.pipedream.com/v1";

function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!obj) return "";
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

// Module-scoped token cache — a soft optimization only (a cold isolate simply refetches); NOT
// relied upon for correctness. Keyed by client_id since a deployment could plausibly hold more
// than one Pipedream OAuth client across environments.
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

async function getPipedreamAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;

  const resp = await fetch(`${PIPEDREAM_API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await resp.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (!resp.ok) {
    const msg = pick(json, "error", "message") || `Pipedream token exchange failed: ${resp.status}`;
    throw new Error(msg);
  }
  const accessToken = pick(json, "access_token");
  const expiresIn = typeof json["expires_in"] === "number" ? (json["expires_in"] as number) : 3600;
  if (!accessToken) throw new Error("Pipedream token exchange did not return an access_token");
  tokenCache.set(clientId, { accessToken, expiresAt: Date.now() + expiresIn * 1000 });
  return accessToken;
}

export interface PipedreamLinkResult {
  connect_url: string;
}

/** Initiates a hosted Pipedream Connect Link for one space+app. Never throws silently — the
 *  caller (/provider-connect/start) surfaces a clear error rather than redirecting into a
 *  broken flow. */
export async function startPipedreamConnect(params: {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  externalUserId: string;
  appSlug: string;
  successRedirectUri: string;
}): Promise<PipedreamLinkResult> {
  const accessToken = await getPipedreamAccessToken(params.clientId, params.clientSecret);
  const resp = await fetch(`${PIPEDREAM_API_BASE}/connect/${encodeURIComponent(params.projectId)}/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${accessToken}`,
      "x-pd-environment": params.environment,
    },
    body: JSON.stringify({
      external_user_id: params.externalUserId,
      success_redirect_uri: params.successRedirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await resp.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (!resp.ok) {
    const msg = pick(json, "error", "message") || `Pipedream connect-token creation failed: ${resp.status}`;
    throw new Error(msg);
  }
  const connectLinkUrl = pick(json, "connect_link_url", "connectLinkUrl");
  if (!connectLinkUrl) {
    throw new Error(
      "Pipedream connect-token response did not include a connect_link_url — unexpected response shape, confirm against live API"
    );
  }
  // The hosted page accepts an `app` query param to preselect/restrict which app the end user
  // connects, so the flow always targets the ONE app this connector declares, not Pipedream's
  // full app catalogue.
  const url = new URL(connectLinkUrl);
  url.searchParams.set("app", params.appSlug);
  return { connect_url: url.toString() };
}

export type PipedreamAccountStatus = "ACTIVE" | "NONE" | "UNKNOWN";

/** Polls for a REAL connected account rather than trusting the success-redirect alone — a user
 *  who bails out of Pipedream's hosted flow (or whose OAuth grant failed on the target app's
 *  side) must never leave a server row claiming success. */
export async function getPipedreamAccountStatus(params: {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  externalUserId: string;
  appSlug: string;
}): Promise<PipedreamAccountStatus> {
  let accessToken: string;
  try {
    accessToken = await getPipedreamAccessToken(params.clientId, params.clientSecret);
  } catch {
    return "UNKNOWN";
  }
  const qs = new URLSearchParams({ external_user_id: params.externalUserId, app: params.appSlug });
  const resp = await fetch(`${PIPEDREAM_API_BASE}/connect/${encodeURIComponent(params.projectId)}/accounts?${qs.toString()}`, {
    headers: { "authorization": `Bearer ${accessToken}`, "x-pd-environment": params.environment },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return "UNKNOWN";
  const json = await resp.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const rows = (Array.isArray(json["data"]) ? json["data"] : Array.isArray(json) ? (json as unknown as unknown[]) : []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return "NONE";
  // A row existing isn't automatically healthy — Pipedream marks a broken/expired grant rather
  // than deleting the row on some failure modes; treat an explicit unhealthy status as NONE
  // (fail closed) rather than ACTIVE, and default to ACTIVE only when no status field is present
  // at all (the common case for a freshly-created, healthy connected account).
  const healthy = rows.some((row) => {
    const status = pick(row, "status", "healthy").toLowerCase();
    return status === "" || status === "active" || status === "connected" || status === "true" || status === "healthy";
  });
  return healthy ? "ACTIVE" : "NONE";
}

// ── Directory: every app Pipedream can reach ─────────────────────────────────────────────────
//
// The counterpart to composio.ts's toolkit directory. Pipedream needs no per-app Auth Config at
// all — Connect takes an app slug directly — so every app it lists has always been connectable;
// what was missing was any way for a user to SEE the list. 3,000+ apps, all with Pipedream-managed
// OAuth, previously reachable only by someone adding a row to CONNECTOR_CATALOGUE by hand.

export interface PipedreamApp {
  slug: string;
  name: string;
  description?: string;
  logo?: string;
  categories: string[];
  /** Pipedream reports this as e.g. "oauth" / "keys" / "none". */
  auth_type?: string;
}

export interface PipedreamAppPage {
  apps: PipedreamApp[];
  next_cursor?: string;
}

/**
 * One page of Pipedream's app directory. Parsed defensively (see this file's header on unverified
 * field names): an entry with no readable slug is skipped rather than rendered as a Connect button
 * that cannot work.
 */
export async function listPipedreamApps(params: {
  clientId: string;
  clientSecret: string;
  search?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}): Promise<PipedreamAppPage> {
  const token = await getPipedreamAccessToken(params.clientId, params.clientSecret);
  const url = new URL(`${PIPEDREAM_API_BASE}/apps`);
  if (params.search) url.searchParams.set("q", params.search);
  if (params.cursor) url.searchParams.set("after", params.cursor);
  url.searchParams.set("limit", String(Math.min(Math.max(params.limit ?? 50, 1), 100)));

  const resp = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const json = await resp.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (!resp.ok) {
    throw new Error(pick(json, "error", "message") || `Pipedream app listing failed: ${resp.status}`);
  }
  const items = (Array.isArray(json["data"]) ? json["data"] : Array.isArray(json["apps"]) ? json["apps"] : []) as Array<
    Record<string, unknown>
  >;
  const apps: PipedreamApp[] = [];
  for (const raw of items) {
    const slug = pick(raw, "name_slug", "slug", "app_slug");
    if (!slug) continue;
    const description = pick(raw, "description");
    const logo = pick(raw, "img_src", "logo", "icon");
    const authType = pick(raw, "auth_type", "authType");
    const categories = Array.isArray(raw["categories"])
      ? (raw["categories"] as unknown[]).map((c) => (typeof c === "string" ? c : "")).filter(Boolean)
      : [];
    apps.push({
      slug,
      name: pick(raw, "name") || slug,
      ...(description ? { description } : {}),
      ...(logo ? { logo } : {}),
      categories,
      ...(authType ? { auth_type: authType } : {}),
    });
  }
  const pageInfo = (json["page_info"] as Record<string, unknown> | undefined) ?? {};
  const nextCursor = pick(pageInfo, "end_cursor", "endCursor") || pick(json, "next_cursor");
  // A cursor equal to nothing, or a short page, means we are at the end — never hand back a
  // cursor that would just replay the same page.
  const hasMore = apps.length >= (params.limit ?? 50);
  return { apps, ...(nextCursor && hasMore ? { next_cursor: nextCursor } : {}) };
}
