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
  const connectionId = pick(data, "id", "connection_id", "connectedAccountId", "connected_account_id");
  if (!redirectUrl || !connectionId) {
    throw new Error(
      "Composio connect-link response did not include a redirect_url/id — unexpected response shape, confirm against live API"
    );
  }
  return { redirect_url: redirectUrl, connection_id: connectionId };
}

export type ComposioConnectionStatus = "ACTIVE" | "INITIATED" | "FAILED" | "EXPIRED" | "UNKNOWN";

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
