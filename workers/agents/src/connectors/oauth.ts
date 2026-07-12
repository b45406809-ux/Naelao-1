/**
 * Generic OAuth2 + PKCE helpers for "Connect with X" connector flows (starting with Whop's
 * "Sign in with Whop" — a real, self-serve OAuth app, no invite needed; a completely separate
 * mechanism from the invite-gated Platforms/connected-accounts API the business-wallet rail
 * (business-wallet.ts) uses). Not Whop-specific code — any future connector with an `oauth` spec
 * in the catalogue reuses these same functions.
 *
 * Flow (mirrors the codebase's own stream-ticket precedent — a short-lived, single-use,
 * server-held ticket rather than putting any credential in a browser-navigable URL):
 *   1. POST /connectors/:platform/oauth/start (authenticated, JSON) generates a PKCE verifier/
 *      challenge pair, stores {verifier, spaceId, tenantId, returnUrl} in AGENT_CACHE keyed by a
 *      random ticket id (10-minute TTL — long enough for a human to click through Whop's consent
 *      screen), and returns {authorize_url} with that ticket id as the OAuth `state` param. The
 *      frontend does a REAL browser navigation to this URL — no Naelao credential ever appears
 *      in it, only an opaque, single-use ticket.
 *   2. Whop redirects the browser back to GET /connectors/:platform/oauth/callback?code=&state=
 *      (PUBLIC/unauthenticated — the ticket IS the auth, single-use, burned on first read). The
 *      callback exchanges the code server-side (holds the client secret), stores the resulting
 *      tokens in the vault, registers the MCP server, and 302s the browser to the caller's own
 *      return_url — the tokens never reach the browser at all.
 */

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generates a PKCE verifier (43-128 char, base64url of 32 random bytes) + its S256 challenge. */
export async function generatePkce(): Promise<PkcePair> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  return { verifier, challenge };
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  /** Epoch millis. */
  expires_at: number;
}

/** Builds the authorize URL the browser is redirected to. */
export function buildAuthorizeUrl(params: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}): string {
  const u = new URL(params.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", params.clientId);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("scope", params.scopes.join(" "));
  u.searchParams.set("state", params.state);
  u.searchParams.set("code_challenge", params.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Exchanges an authorization code for tokens (server-to-server; holds the client secret). */
export async function exchangeCodeForTokens(params: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<OAuthTokens> {
  const resp = await fetch(params.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    }),
  });
  const json = await resp.json<TokenResponse>().catch(() => ({}) as TokenResponse);
  if (!resp.ok || !json.access_token || !json.refresh_token) {
    throw new Error(`OAuth token exchange failed: ${resp.status} ${json.error ?? ""} ${json.error_description ?? ""}`.trim());
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

/** Refreshes an access token. Whop's refresh tokens ROTATE on each use — always persist the new
 *  refresh_token returned here, never reuse the old one. */
export async function refreshTokens(params: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<OAuthTokens> {
  const resp = await fetch(params.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: params.clientId,
      client_secret: params.clientSecret,
      refresh_token: params.refreshToken,
    }),
  });
  const json = await resp.json<TokenResponse>().catch(() => ({}) as TokenResponse);
  if (!resp.ok || !json.access_token || !json.refresh_token) {
    throw new Error(`OAuth token refresh failed: ${resp.status} ${json.error ?? ""} ${json.error_description ?? ""}`.trim());
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

export interface OAuthTicket {
  verifier: string;
  spaceId: string;
  tenantId: string;
  userId: string;
  returnUrl: string;
  platform: string;
}

const TICKET_TTL_SECONDS = 600;

export function oauthTicketKey(ticket: string): string {
  return `connector-oauth-ticket:${ticket}`;
}

export async function issueOAuthTicket(kv: KVNamespace, data: OAuthTicket): Promise<string> {
  const ticket = crypto.randomUUID();
  await kv.put(oauthTicketKey(ticket), JSON.stringify(data), { expirationTtl: TICKET_TTL_SECONDS });
  return ticket;
}

/** Single-use: reads and immediately deletes the ticket, so a replayed callback URL (e.g. from
 *  browser history or a proxy log) can never redeem the same ticket twice. */
export async function consumeOAuthTicket(kv: KVNamespace, ticket: string): Promise<OAuthTicket | null> {
  const raw = await kv.get(oauthTicketKey(ticket));
  if (!raw) return null;
  await kv.delete(oauthTicketKey(ticket));
  try {
    return JSON.parse(raw) as OAuthTicket;
  } catch {
    return null;
  }
}
